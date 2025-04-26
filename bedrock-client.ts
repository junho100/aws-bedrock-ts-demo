import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import dedent from "ts-dedent";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ApiResponse {
  text: string;
  token_usage: TokenUsage;
}

export interface FrameAnalysisResult {
  sequence_summary: string;
  key_events: {
    frame_range: [number, number];
    event_description: string;
  }[];
}

export interface VideoAnalysisSummary {
  summary: string;
  key_events: {
    description: string;
    significance: "HIGH" | "MEDIUM" | "LOW";
  }[];
  objects_involved: {
    people?: string[];
    items: string[];
  };
  analysis: {
    pattern: string;
    anomalies: string[];
    risk_assessment: string;
  };
}

export class BedrockClient {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private totalTokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(
    options: {
      region?: string;
      profile?: string;
      modelId?: string;
    } = {}
  ) {
    this.client = new BedrockRuntimeClient({
      region: options.region || "us-east-1",
      credentials: options.profile
        ? fromIni({ profile: options.profile })
        : undefined,
    });
    this.modelId = options.modelId || "anthropic.claude-3-haiku-20240307-v1:0";
  }

  /**
   * 연속된 프레임들을 분석하여 설명을 생성합니다.
   * @param frames 분석할 프레임들의 base64 인코딩 문자열 배열
   * @param frameIndices 프레임 인덱스 배열
   * @param prevFrameDesc 이전 프레임 설명
   */
  async analyzeFrames(
    frames: string[],
    frameIndices: number[],
    prevFrameDesc: string = "None"
  ): Promise<FrameAnalysisResult> {
    const systemPrompt = `
    System:
    1. You are a CCTV Video Analysis Expert specialized in analyzing sequences of surveillance footage frames and describing situations in natural language.
    2. Your role is to observe multiple consecutive frames and provide comprehensive situation analysis while maintaining objectivity and focus on relevant activities.

    Model Instructions:
    - You MUST analyze frames chronologically 
    - You MUST focus on task, movement and behavioral patterns
    - You MUST write all descriptions in Korean
    - You MUST highlight significant changes or anomalies
    - DO NOT describe static objects or background elements
    - DO NOT make subjective interpretations
    - DO NOT focus on counting or identifying specific individuals
    - DO NOT speculate about unclear situations

    Input Format:
    - frames: Array of consecutive CCTV frame images
    - frame_count: Number of provided frames
    - prev_frame_desc: Description of previous frame sequence

    Output Schema:
    {
        "sequence_summary": string,  // Objective description of observed situation
        "key_events": [
            {
                "frame_range": [start_frame, end_frame],
                "event_description": string  // Description of significant event
            }
        ]
    }

    Analysis Guidelines:
    1. Movement Tracking:
       - Track continuous movement patterns
       - Note entry/exit from frame
       - Document significant position changes
       - Identify reappearing subjects

    2. Sequence Understanding:
       - The images are arranged in chronological order, showing the sequence of events as they occurred based on timestamps
       - Review frames chronologically
       - Consider previous sequence context
       - Maintain continuity in descriptions
       - Focus on action progression

    3. Visual Quality Assessment:
       - Report visual obstructions
       - Note lighting conditions
       - Mention quality limitations
       - Identify unclear areas

    4. Critical Observations:
       - Highlight unusual activities
       - Note behavioral anomalies
       - Document significant changes
       - Mark suspicious patterns

    5. Behavioral Focus:
       - Emphasize actions over identities
       - Track behavioral patterns
       - Note interactions
       - Document activity sequences

    Remember:
    - Maintain chronological continuity
    - Focus on observable actions
    - Be objective and clear
    - Highlight significant changes
    - Note technical limitations
    - Track subject reappearances
    `;

    const userPrompt = `
    Frame_count:
    ${frameIndices.length}
    Prev_frame_desc:
    ${prevFrameDesc}
    `;

    const messages = [
      {
        role: "user",
        content: [
          ...frames.map((frame) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: frame,
            },
          })),
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ];

    const result = await this.invokeModel(messages, dedent(systemPrompt));
    return JSON.parse(result.text) as FrameAnalysisResult;
  }

  /**
   * 프레임 설명 목록을 분석하여 종합적인 비디오 분석 요약을 생성합니다.
   * @param frameDescriptions 프레임 설명 배열
   */
  async generateSummary(
    frameDescriptions: string[]
  ): Promise<VideoAnalysisSummary> {
    const systemPrompt = `
    System:
    1. You are a CCTV Surveillance Analysis Expert specialized in synthesizing frame-by-frame descriptions into comprehensive situational analysis.
    2. Your role is to analyze sequential frame descriptions, identify meaningful patterns, extract significant events, and assess security risks while maintaining privacy considerations.

    Model Instructions:
    1. Analysis Requirements:
      - You MUST review frame descriptions chronologically
      - You MUST identify and extract meaningful events
      - You MUST write all content in Korean
      - You MUST evaluate event significance based on security impact
      - DO NOT include personally identifiable information
      - DO NOT speculate about unclear situations
      - DO NOT include routine movements as key events

    2. Event Assessment Criteria:
      - Security risks and threats
      - Abnormal behavior patterns
      - Property/facility risks
      - Pattern repetition
      - Contextual significance

    Input Format:
    frame_descriptions: [
       string  // Sequential frame descriptions
    ]

    Output Schema:
    {
       "summary": string,  // Comprehensive situation analysis
       "key_events": [
           {
               "description": string,  // Event description
               "significance": "HIGH/MEDIUM/LOW"  // Event importance
           }
       ],
       "objects_involved": {
           "people": [string],  // Roles without specific identifiers
           "items": [string]    // Key objects
       },
       "analysis": {
           "pattern": string,   // Identified behavior patterns
           "anomalies": [string], // Unusual activities
           "risk_assessment": string  // Potential risk evaluation
       }
    }

    Analysis Guidelines:
    1. Sequence Analysis:
      - Review descriptions chronologically
      - Verify sequence consistency
      - Identify behavioral patterns
      - Track subject continuity
      - Note temporal relationships

    2. Event Prioritization:
      - Focus on security-relevant events
      - Evaluate behavior patterns
      - Assess potential risks
      - Exclude routine activities
      - Identify repeated patterns

    3. Risk Assessment:
      - Evaluate security implications
      - Identify potential threats
      - Assess pattern abnormalities
      - Consider contextual factors
      - Flag suspicious activities

    4. Pattern Recognition:
      - Identify behavioral trends
      - Note recurring events
      - Track movement patterns
      - Document unusual sequences
      - Compare with normal activity

    Remember:
    - Maintain objectivity in analysis
    - Prioritize security and privacy
    - Focus on significant patterns
    - Exclude non-essential details
    - Report only observed facts
    - Consider full context
    - Flag potential security risks
    `;

    const userPrompt = `
    Frame_descriptions:
    ${JSON.stringify(frameDescriptions)}
    `;

    const messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const result = await this.invokeModel(messages, dedent(systemPrompt));
    return JSON.parse(result.text) as VideoAnalysisSummary;
  }

  /**
   * Bedrock 모델을 호출하는 내부 메서드
   */
  private async invokeModel(
    messages: any[],
    systemPrompt: string
  ): Promise<ApiResponse> {
    const params = {
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1024,
        temperature: 0.01,
        system: systemPrompt,
        messages: messages,
      }),
    };

    const command = new InvokeModelCommand(params);
    const response = await this.client.send(command);

    // 응답 처리
    const responseBody = JSON.parse(Buffer.from(response.body).toString());
    if (responseBody.usage) {
      this.totalTokens.inputTokens += responseBody.usage.input_tokens || 0;
      this.totalTokens.outputTokens += responseBody.usage.output_tokens || 0;
      this.totalTokens.totalTokens =
        this.totalTokens.inputTokens + this.totalTokens.outputTokens;
    }

    return {
      text: responseBody.content[0].text,
      token_usage: {
        inputTokens: responseBody.usage?.input_tokens || 0,
        outputTokens: responseBody.usage?.output_tokens || 0,
        totalTokens:
          (responseBody.usage?.input_tokens || 0) +
          (responseBody.usage?.output_tokens || 0),
      },
    };
  }

  /**
   * 지금까지 사용된 토큰 사용량과 비용을 계산합니다.
   */
  getTokenUsage(): { tokens: TokenUsage; cost: number } {
    // Nova 모델 가격 (예시)
    const inputCostPer1K = 0.00095;
    const outputCostPer1K = 0.0038;

    const inputCost = (this.totalTokens.inputTokens / 1000) * inputCostPer1K;
    const outputCost = (this.totalTokens.outputTokens / 1000) * outputCostPer1K;

    return {
      tokens: this.totalTokens,
      cost: inputCost + outputCost,
    };
  }
}
