import * as fs from "fs";
import * as path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { v4 as uuidv4 } from "uuid";
import * as rimraf from "rimraf";
import https from "https";
import http from "http";
import ffmpeg from "fluent-ffmpeg";
import {
  BedrockClient,
  FrameAnalysisResult,
  VideoAnalysisSummary,
} from "./bedrock-client";

interface VideoProcessingConfig {
  sampleMsec: number;
  resizeRatio: number;
  frameBatchSize: number;
  slidingWindowSize: number;
  outputDir: string;
}

interface VideoInfo {
  totalFrameCount: number;
  sampledCount: number;
  frameWidth: number;
  frameHeight: number;
}

interface SampledFrames {
  framePaths: string[];
  indices: number[];
}

// 기본 설정
const DEFAULT_CONFIG: VideoProcessingConfig = {
  sampleMsec: 1000,
  resizeRatio: 0.7,
  frameBatchSize: 7,
  slidingWindowSize: 7,
  outputDir: "./workspace",
};

/**
 * 비디오 처리 및 분석을 담당하는 클래스
 */
export class VideoAnalyzer {
  private tempDir: string;
  private bedrock: BedrockClient;
  private config: VideoProcessingConfig;

  /**
   * VideoAnalyzer 인스턴스 생성
   * @param videoUrl 처리할 비디오 URL
   * @param config 비디오 처리 설정
   */
  constructor(
    private videoUrl: string,
    config?: Partial<VideoProcessingConfig>,
    bedrockOptions?: { region?: string; profile?: string; modelId?: string }
  ) {
    // 기본 설정과 사용자 설정 병합
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 임시 작업 디렉토리 생성
    this.tempDir = path.join(process.cwd(), "tmp_" + uuidv4());
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // 출력 디렉토리 생성
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }

    // Bedrock 클라이언트 생성
    this.bedrock = new BedrockClient(bedrockOptions);
  }

  /**
   * 비디오 분석 파이프라인 실행
   */
  async analyze(): Promise<VideoAnalysisSummary> {
    console.log("비디오 분석 시작...");
    try {
      // 1. 비디오 다운로드
      const videoPath = await this.downloadVideoFromUrl();

      // 2. 프레임 샘플링
      const { sampledFrames, videoInfo } = await this.sampleVideoFrames(
        videoPath
      );

      // 3. 슬라이딩 윈도우 적용
      const windows = this.applySlidingWindow(
        sampledFrames,
        this.config.frameBatchSize,
        this.config.slidingWindowSize
      );

      // 4. 각 윈도우별 설명 생성
      const frameDescriptions = await this.generateFrameDescriptions(windows);

      // 5. 최종 요약 생성
      const summary = await this.generateVideoSummary(frameDescriptions);

      // 6. 토큰 사용량 출력
      this.printTokenUsage();

      return summary;
    } catch (error) {
      console.error("비디오 분석 중 오류 발생:", error);
      throw error;
    } finally {
      // 7. 임시 파일 정리
      this.cleanup();
    }
  }

  /**
   * URL에서 비디오 파일 다운로드
   * @returns 다운로드된 비디오 파일의 로컬 경로
   */
  private async downloadVideoFromUrl(): Promise<string> {
    console.log(`URL에서 비디오 다운로드 중: ${this.videoUrl}`);

    // URL에서 파일이름 추출
    const fileName = path.basename(new URL(this.videoUrl).pathname);
    const localFilePath = path.join(this.tempDir, fileName);
    const writeStream = createWriteStream(localFilePath);

    try {
      await new Promise<void>((resolve, reject) => {
        const protocol = this.videoUrl.startsWith("https") ? https : http;

        const request = protocol.get(this.videoUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`다운로드 실패: HTTP 상태 코드 ${response.statusCode}`)
            );
            return;
          }

          pipeline(response, writeStream)
            .then(() => resolve())
            .catch((err) => reject(err));
        });

        request.on("error", (err) => {
          reject(new Error(`비디오 다운로드 요청 오류: ${err.message}`));
        });
      });

      console.log(`비디오가 다음 경로에 다운로드 되었습니다: ${localFilePath}`);
      return localFilePath;
    } catch (error) {
      console.error("비디오 다운로드 오류:", error);
      throw error;
    }
  }

  /**
   * ffmpeg를 사용한 비디오 정보 가져오기
   * @param videoPath 비디오 파일 경로
   */
  private getVideoInfo(videoPath: string): Promise<{
    fps: number;
    frameCount: number;
    width: number;
    height: number;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(
            new Error(`비디오 정보를 가져오는데 실패했습니다: ${err.message}`)
          );
          return;
        }

        try {
          const videoStream = metadata.streams.find(
            (stream) => stream.codec_type === "video"
          );

          if (!videoStream) {
            reject(new Error("비디오 스트림을 찾을 수 없습니다"));
            return;
          }

          // 프레임 레이트 계산
          let fps = 0;
          if (videoStream.r_frame_rate) {
            const [num, denom] = videoStream.r_frame_rate
              .split("/")
              .map(Number);
            fps = num / denom;
          }

          // 전체 프레임 수
          let frameCount = parseInt(videoStream.nb_frames || "0", 10);

          // 가끔 nb_frames가 없는 경우 비디오 길이와 fps로 계산
          if (isNaN(frameCount) && videoStream.duration && fps) {
            frameCount = Math.ceil(parseFloat(videoStream.duration) * fps);
          }

          resolve({
            fps,
            frameCount: isNaN(frameCount) ? 0 : frameCount,
            width: videoStream.width || 0,
            height: videoStream.height || 0,
          });
        } catch (error) {
          reject(new Error(`비디오 정보 파싱 실패: ${error}`));
        }
      });
    });
  }

  /**
   * 비디오에서 프레임 샘플링
   * @param videoPath 비디오 파일 경로
   * @returns 샘플링된 프레임 정보
   */
  private async sampleVideoFrames(videoPath: string): Promise<{
    sampledFrames: SampledFrames;
    videoInfo: VideoInfo;
  }> {
    return new Promise(async (resolve, reject) => {
      try {
        console.log("비디오에서 프레임 샘플링 중...");

        // 프레임 저장 디렉토리 생성
        const framesDir = path.join(this.config.outputDir, "frames");
        this.setupDirectory(framesDir);

        // 비디오 정보 가져오기
        const videoMetadata = await this.getVideoInfo(videoPath);
        console.log("비디오 정보:", videoMetadata);

        // 샘플링 간격 계산 (프레임 단위)
        const frameInterval = Math.max(
          1,
          Math.round((this.config.sampleMsec / 1000) * videoMetadata.fps)
        );

        console.log(
          `프레임 추출 간격: ${frameInterval} 프레임 (${this.config.sampleMsec}ms)`
        );

        // ffmpeg로 프레임 추출
        const framePattern = path.join(framesDir, "frame_%06d.jpg");

        await new Promise<void>((resolveExtract, rejectExtract) => {
          ffmpeg(videoPath)
            .outputOptions([
              `-vf select='not(mod(n,${frameInterval}))',scale=iw*${this.config.resizeRatio}:ih*${this.config.resizeRatio}`,
              "-vsync 0",
              "-q:v 2", // 품질 설정 (2는 고품질)
            ])
            .output(framePattern)
            .on("end", () => resolveExtract())
            .on("error", (err) =>
              rejectExtract(new Error(`프레임 추출 실패: ${err.message}`))
            )
            .run();
        });

        // 추출된 프레임 파일 목록 가져오기
        const framePaths = fs
          .readdirSync(framesDir)
          .filter((file) => file.startsWith("frame_") && file.endsWith(".jpg"))
          .map((file) => path.join(framesDir, file))
          .sort();

        // 프레임 인덱스 추출
        const indices = framePaths.map((framePath) => {
          const filename = path.basename(framePath);
          const match = filename.match(/frame_(\d+)\.jpg/);
          return match ? parseInt(match[1], 10) : 0;
        });

        const sampledCount = framePaths.length;

        console.log(`${sampledCount}개의 프레임 추출 완료`);
        console.log(
          `프레임 크기: ${Math.round(
            videoMetadata.width * this.config.resizeRatio
          )}x${Math.round(videoMetadata.height * this.config.resizeRatio)}`
        );

        const videoInfo: VideoInfo = {
          totalFrameCount: videoMetadata.frameCount,
          sampledCount,
          frameWidth: Math.round(videoMetadata.width * this.config.resizeRatio),
          frameHeight: Math.round(
            videoMetadata.height * this.config.resizeRatio
          ),
        };

        resolve({
          sampledFrames: {
            framePaths,
            indices,
          },
          videoInfo,
        });
      } catch (error) {
        reject(new Error(`프레임 샘플링 실패: ${error}`));
      }
    });
  }

  /**
   * 프레임 배열에 슬라이딩 윈도우 적용
   * @param sampledFrames 샘플링된 프레임 정보
   * @param batchSize 각 윈도우에 포함될 프레임 수
   * @param slideSize 슬라이딩 윈도우 이동 크기
   * @returns 각 윈도우에 해당하는 프레임 정보 배열
   */
  private applySlidingWindow(
    sampledFrames: SampledFrames,
    batchSize: number,
    slideSize: number
  ): SampledFrames[] {
    console.log("슬라이딩 윈도우 적용 중...");

    const { framePaths, indices } = sampledFrames;
    const windows: SampledFrames[] = [];
    const totalFrames = framePaths.length;

    // 매개변수 유효성 검사
    if (batchSize > totalFrames) {
      throw new Error(
        `배치 크기(${batchSize})는 총 프레임 수(${totalFrames})보다 클 수 없습니다`
      );
    }

    // 슬라이딩 윈도우 설정이 모든 프레임을 커버하는지 확인
    const remainingFrames = (totalFrames - batchSize) % slideSize;
    if (remainingFrames !== 0) {
      console.warn(
        `경고: 현재 매개변수로는 마지막 ${remainingFrames}개의 프레임이 생략될 수 있습니다`
      );
      console.warn(
        "권장 슬라이딩 간격:",
        Array.from({ length: batchSize - 1 }, (_, i) => i + 1).filter(
          (i) => (totalFrames - batchSize) % i === 0
        )
      );
    }

    // 마지막 유효한 시작 위치 계산
    const lastStart = totalFrames - batchSize;

    // 윈도우 생성
    for (let i = 0; i <= lastStart; i += slideSize) {
      windows.push({
        framePaths: framePaths.slice(i, i + batchSize),
        indices: indices.slice(i, i + batchSize),
      });
    }

    console.log(
      `배치 크기 ${batchSize}, 슬라이드 크기 ${slideSize}로 ${windows.length}개의 윈도우 생성됨`
    );
    return windows;
  }

  /**
   * 이미지 파일을 Base64로 변환
   * @param filePath 이미지 파일 경로
   */
  private imageFileToBase64(filePath: string): string {
    const fileData = fs.readFileSync(filePath);
    return fileData.toString("base64");
  }

  /**
   * 각 윈도우별로 프레임 설명 생성
   * @param windows 윈도우별 프레임 정보
   * @returns 각 윈도우에 대한 설명 배열
   */
  private async generateFrameDescriptions(
    windows: SampledFrames[]
  ): Promise<string[]> {
    console.log("프레임 윈도우 설명 생성 중...");

    const descriptions: string[] = [];
    let prevFrameDesc = "None";

    for (let i = 0; i < windows.length; i++) {
      console.log(`윈도우 ${i + 1}/${windows.length} 분석 중...`);

      const window = windows[i];

      // 프레임 파일을 Base64로 인코딩
      const base64Frames = window.framePaths.map((filePath) =>
        this.imageFileToBase64(filePath)
      );

      // Bedrock API 호출
      try {
        const result = await this.bedrock.analyzeFrames(
          base64Frames,
          window.indices,
          prevFrameDesc
        );

        descriptions.push(result.sequence_summary);
        prevFrameDesc = result.sequence_summary;

        console.log(
          `윈도우 ${i + 1} 분석 완료: ${
            result.key_events.length
          }개의 이벤트 감지됨`
        );
      } catch (error) {
        console.error(`윈도우 ${i + 1} 분석 중 오류:`, error);
        // 오류가 있더라도 계속 진행
        descriptions.push(`[오류: 이 윈도우 분석에 실패했습니다.]`);
      }
    }

    return descriptions;
  }

  /**
   * 모든 프레임 설명을 종합하여 비디오 요약 생성
   * @param frameDescriptions 프레임 설명 배열
   * @returns 비디오 분석 요약
   */
  private async generateVideoSummary(
    frameDescriptions: string[]
  ): Promise<VideoAnalysisSummary> {
    console.log("비디오 종합 요약 생성 중...");

    try {
      const summary = await this.bedrock.generateSummary(frameDescriptions);
      console.log("비디오 요약이 성공적으로 생성되었습니다.");
      return summary;
    } catch (error) {
      console.error("비디오 요약 생성 중 오류:", error);
      throw new Error(`비디오 요약 생성 실패: ${error}`);
    }
  }

  /**
   * 토큰 사용량 및 비용 출력
   */
  private printTokenUsage(): void {
    const usage = this.bedrock.getTokenUsage();

    console.log("\n======= 토큰 사용량 및 비용 =======");
    console.log(`입력 토큰: ${usage.tokens.inputTokens.toLocaleString()}`);
    console.log(`출력 토큰: ${usage.tokens.outputTokens.toLocaleString()}`);
    console.log(`총 토큰: ${usage.tokens.totalTokens.toLocaleString()}`);
    console.log(`예상 비용: $${usage.cost.toFixed(4)} USD`);
    console.log("====================================");
  }

  /**
   * 디렉토리 생성 또는 재생성
   * @param dirPath 설정할 디렉토리 경로
   */
  private setupDirectory(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      rimraf.sync(dirPath);
      console.log(`기존 디렉토리 삭제됨: ${dirPath}`);
    }

    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`디렉토리 생성됨: ${dirPath}`);
  }

  /**
   * 임시 파일 정리
   */
  private cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      rimraf.sync(this.tempDir);
      console.log(`임시 디렉토리 정리 완료: ${this.tempDir}`);
    }
  }
}
