import { VideoAnalyzer } from "./index";
import { config } from "./config";

async function main() {
  console.log("=== 비디오 분석 시작 ===");
  console.log(`비디오 URL: ${config.videoUrl}`);

  // VideoAnalyzer 인스턴스 생성
  const analyzer = new VideoAnalyzer(
    config.videoUrl,
    config.videoProcessing,
    config.aws
  );

  try {
    // 비디오 분석 실행
    const summary = await analyzer.analyze();

    // 결과 출력
    console.log("\n================ 비디오 분석 결과 ================");
    console.log("요약:");
    console.log(summary.summary);

    console.log("\n주요 이벤트:");
    summary.key_events.forEach((event, i) => {
      console.log(
        `${i + 1}. ${event.description} (중요도: ${event.significance})`
      );
    });

    console.log("\n관련 객체:");
    if (summary.objects_involved.people) {
      console.log("사람:", summary.objects_involved.people.join(", "));
    }
    console.log("물체:", summary.objects_involved.items.join(", "));

    console.log("\n분석:");
    console.log("패턴:", summary.analysis.pattern);
    console.log("이상 징후:", summary.analysis.anomalies.join(", "));
    console.log("위험 평가:", summary.analysis.risk_assessment);
    console.log("==================================================");
  } catch (error) {
    console.error("분석 중 오류 발생:", error);
  }
}

// 실행
main().catch((error) => {
  console.error("프로그램 실행 중 오류 발생:", error);
  process.exit(1);
});
