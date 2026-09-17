import { EventEmitter } from "events";
import { AIVoiceConfig } from "./types.js";
export declare class OpenAIClient extends EventEmitter {
    private ws;
    private config;
    private isConnected;
    private onAudioCallback?;
    private onEndCallCallback?;
    private watchdogTimer;
    private sawResponseCreated;
    private pendingEndCall;
    private wasGoodbyeInterrupted;
    private openaiWavWriter;
    private debugAudioFile;
    private conversationItems;
    private responseTrackers;
    private canceledResponses;
    private currentResponseId;
    private responseHasAudio;
    private currentUserTranscript;
    private pendingTranscripts;
    private itemToResponseMap;
    private playbackCompleted;
    private cleanupTimers;
    private manualResponseControl;
    private perfStats;
    constructor(config: AIVoiceConfig);
    private setupWebSocketHandlers;
    connect(): Promise<void>;
    private setupSession;
    disconnect(): Promise<void>;
    private send;
    private generateEventId;
    sendAudio(audioData: Int16Array): void;
    private arrayBufferToBase64;
    sendText(text: string): void;
    /**
     * Enable/disable manual response control. Must be called before connect()
     * (or before the next session.update) to take effect, since it changes the
     * session's turn_detection.create_response setting.
     */
    setManualResponseControl(enabled: boolean): void;
    /**
     * Replace the instructions used for subsequent responses (createResponse()
     * always reads the latest value). Used by inbound call routing to inject
     * topic-specific context/answers once a caller's question has been
     * classified, without needing a full session reconnect.
     */
    updateInstructions(instructions: string): void;
    getInstructions(): string | undefined;
    createResponse(): void;
    onAudioReceived(callback: (audio: Int16Array, responseId?: string) => void): void;
    onEndCall(callback: () => void): void;
    getConversationItems(): any[];
    isReady(): boolean;
    private setupOpenAIWavRecording;
    /**
     * Log a queued transcript when audio playback finishes
     */
    logQueuedTranscript(responseId: string): void;
    /**
     * Schedule a safety cleanup timer to prevent memory leaks
     */
    private scheduleSafetyCleanup;
    /**
     * Clean up tracking data for a response
     */
    private cleanupResponse;
    private startResponseWatchdog;
    forceEndCallTurn(reason?: string): void;
    executePendingEndCall(): void;
    private executeEndCallFunction;
    private logOpenAIPerformanceStats;
}
//# sourceMappingURL=openai-client.d.ts.map