export interface SIPConfig {
  username: string;
  password: string;
  serverIp: string;
  serverPort: number;
  localPort: number;
}

// Enhanced SIP configuration extending the basic SIPConfig
export interface SIPAdvancedConfig extends SIPConfig {
  // NAT Traversal Configuration
  stunServers?: string[];           // STUN servers for NAT detection
  turnServers?: TurnServer[];       // TURN relays for strict NAT
  iceEnabled?: boolean;             // Enable ICE candidate gathering
  
  // Transport Layer Configuration
  preferredTransports?: ('udp' | 'tcp' | 'tls')[];  // Transport priority
  tlsOptions?: TLSConfig;           // TLS-specific settings
  
  // SIP Protocol Features
  sessionTimers?: SessionTimerConfig;    // RFC 4028 session refresh
  prackSupport?: 'required' | 'supported' | 'disabled';  // RFC 3262
  keepAlive?: KeepaliveConfig;      // Connection maintenance
  
  // Provider Integration
  provider?: string;                // References built-in profile
  customProfile?: SIPProviderProfile;    // Override built-in profile
  _providerProfile?: SIPProviderProfile; // Resolved profile (internal)
  
  // Audio Configuration
  audio?: AudioConfig;              // Audio/codec preferences
}

// TURN server configuration
export interface TurnServer {
  urls: string[];
  username: string;
  password: string;
}

// TLS configuration options
export interface TLSConfig {
  rejectUnauthorized?: boolean;
  cert?: string;
  key?: string;
  ca?: string;
}

// Session timer configuration (RFC 4028)
export interface SessionTimerConfig {
  enabled: boolean;
  expires?: number;                 // Session refresh interval (seconds)
  minSE?: number;                   // Minimum session expires
  refresher?: 'uac' | 'uas';        // Who refreshes the session
}

// Keepalive configuration
export interface KeepaliveConfig {
  method: 'register' | 'options' | 'double-crlf';
  interval: number;                 // Keepalive interval (seconds)
}

// Audio configuration
export interface AudioConfig {
  preferredCodecs?: number[];       // Payload type preferences [9, 0, 8]
  dtmfMethod?: 'rfc4733' | 'info';  // DTMF transmission method
  mediaTimeout?: number;            // RTP timeout (seconds)
}

// Provider profile schema - encodes SIP provider requirements
export interface SIPProviderProfile {
  name: string;                     // Human-readable provider name
  description: string;              // Provider description
  requirements: ProviderRequirements;    // Technical requirements
  sdpOptions: SDPOptions;           // Media negotiation preferences
  quirks?: ProviderQuirks;          // Provider-specific workarounds
}

// Provider technical requirements
export interface ProviderRequirements {
  stunServers?: string[];           // Required STUN servers
  transport: string[];              // Supported transports ['udp', 'tcp', 'tls']
  sessionTimers: boolean;           // Session timer support required
  prackSupport: 'required' | 'supported' | 'disabled';  // PRACK requirement level
  authMethods: string[];            // Authentication methods ['digest']
  keepAliveMethod: string;          // Preferred keepalive method
  keepAliveInterval: number;        // Keepalive interval (seconds)
}

// SDP and media options
export interface SDPOptions {
  preferredCodecs: number[];        // Codec priority order
  dtmfMethod: string;               // DTMF method preference
  mediaTimeout: number;             // Media timeout (seconds)
}

// Provider-specific quirks and workarounds
export interface ProviderQuirks {
  [key: string]: any;               // Flexible structure for provider-specific settings
}

export interface CallConfig {
  targetNumber: string;
  duration?: number;
}

export interface AIVoiceConfig {
  openaiApiKey: string;
  voice?: string;
  instructions?: string;
  brief?: string;
  userName?: string;
  language?: string; // ISO-639-1 language code for transcription
}

// A single "event"/topic that the inbound call router can answer questions
// about. Each topic maps to either a static knowledge snippet, an external
// MCP-style endpoint, or both (endpoint is preferred when reachable).
export interface EventTopic {
  id: string;                       // Stable identifier used for routing/logging
  name: string;                     // Human-readable topic name (e.g. "Community Fair 2026")
  description: string;              // Short description used by the router's classifier
  keywords?: string[];              // Optional keywords to aid classification
  knowledge?: string;               // Fallback knowledge/context used to ground answers
  mcpEndpoint?: string;             // Optional HTTP endpoint of an MCP server/tool that can answer
}

// Configuration for accepting inbound calls and routing caller questions
// to the appropriate topic/MCP knowledge source.
export interface InboundConfig {
  enabled: boolean;                 // Enable inbound call handling
  autoAnswer?: boolean;             // Automatically accept incoming INVITEs (default: true)
  greeting?: string;                // Spoken greeting played when the call connects
  noMatchMessage?: string;          // Fallback message when no topic matches the caller's question
  confidenceThreshold?: number;     // Minimum router confidence (0-1) required to route to a topic
  topics: EventTopic[];             // Registry of topics/events the system can answer questions about
}

export interface Config {
  sip: SIPConfig | SIPAdvancedConfig;
  ai?: AIVoiceConfig;
  openai?: AIVoiceConfig; // For backward compatibility
  audio?: AudioConfig; // For backward compatibility
  logging?: any; // For backward compatibility
  call?: any; // For backward compatibility
  inbound?: InboundConfig; // Inbound call acceptance + topic routing configuration
}

export interface CallEvent {
  type: 'REGISTERED' | 'REGISTER_FAILED' | 'CALL_INITIATED' | 'CALL_ANSWERED' | 'CALL_ENDED' | 'ERROR' |
        'CONNECTED' | 'DISCONNECTED' | 'SESSION_REFRESH' | 'TRANSPORT_FALLBACK' | 'AUTH_RETRY' | 'CONNECTION_FAILED' |
        'INCOMING_CALL';
  message?: any;
  data?: any;
  endedBy?: 'remote' | 'local';
}

// Configuration loading and validation interfaces
export interface ConfigLoadOptions {
  provider?: string;                // Override provider detection
  validateNetwork?: boolean;        // Test network connectivity
  strictValidation?: boolean;       // Fail on warnings
}

export interface ConfigLoadResult {
  config: SIPAdvancedConfig;
  warnings: string[];
  suggestions: string[];
  providerInfo: {
    id: string;
    name: string;
    autoDetected: boolean;
  };
}

export interface ValidationResult {
  config: SIPAdvancedConfig;
  warnings: ValidationWarning[];
  suggestions: ValidationSuggestion[];
  errors: ValidationError[];
  isValid: boolean;
}

export interface ValidationError {
  type: string;
  message: string;
  field?: string;
  suggestion?: string;
}

export interface ValidationWarning {
  type: string;
  message: string;
  suggestion?: string;
}

export interface ValidationSuggestion {
  type: string;
  message: string;
  priority?: 'low' | 'medium' | 'high' | 'info';
}

// Provider compatibility and testing interfaces
export interface ProviderCompatibilityReport {
  score: number;                    // 0-100 compatibility score
  provider?: string;                // Provider name
  issues: string[];                 // List of compatibility issues
}

export interface NetworkTestResult {
  sipServer: {
    reachable: boolean;
    latency?: number;
    error?: string;
    protocol?: string;
  };
  stunServers: Array<{
    server: string;
    reachable: boolean;
    error?: string;
    natType?: string;
  }>;
  recommendations: string[];
}

export interface ValidationReport {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  suggestions: ValidationSuggestion[];
  providerCompatibility: ProviderCompatibilityReport;
  networkConnectivity?: NetworkTestResult;
}

// Configuration error handling
export class ConfigurationError extends Error {
  constructor(public details: {
    message: string;
    configPath?: string;
    suggestions: string[];
    exampleConfigs?: string[];
  }) {
    super(details.message);
    this.name = 'ConfigurationError';
  }
}