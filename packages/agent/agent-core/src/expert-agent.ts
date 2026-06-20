export type ExpertAgentSchemaVersion = "expertmesh.expert/v1";

export type ExpertAgentSkillPackageType = "builtin" | "registry" | "local";

export interface IExpertAgentMcpServer {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly timeout?: number;
  readonly token?: string;
  readonly allowTools?: readonly string[];
  readonly disallowTools?: readonly string[];
}

export interface IExpertAgentMcpConfig {
  readonly mcpServers: Record<string, IExpertAgentMcpServer>;
}

export interface IExpertAgentSkill {
  readonly type: ExpertAgentSkillPackageType;
  readonly name: string;
  readonly description: string;
  readonly version?: string | null;
}

export interface IExpertAgentSkillsConfig {
  readonly skills: readonly IExpertAgentSkill[];
}

export interface IExpertAgentInitializeRequest {
  readonly workspace?: string;
}

export interface IExpertAgentInitializeResult {
  readonly ready: boolean;
}

export type ExpertAgentInitializeFunction = (
  request?: IExpertAgentInitializeRequest
) => Promise<IExpertAgentInitializeResult>;

export interface IExpertAgentRunRequest<TInput = string> {
  readonly task: string;
  readonly input: TInput;
}

export interface IExpertAgentRunResult<TOutput = string> {
  readonly output: TOutput;
}

export type ExpertAgentRunFunction<TInput = string, TOutput = string> = (
  request: IExpertAgentRunRequest<TInput>
) => Promise<IExpertAgentRunResult<TOutput>>;

export interface IExpertAgent<TInput = string, TOutput = string> {
  readonly schemaVersion: ExpertAgentSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly mcp?: IExpertAgentMcpConfig;
  readonly skills?: IExpertAgentSkillsConfig;
  readonly agentsMd?: string;
  readonly documents?: string;
  readonly workspace?: string;
  readonly initialize: ExpertAgentInitializeFunction;
  readonly run: ExpertAgentRunFunction<TInput, TOutput>;
}

export type ExpertAgent<TInput = string, TOutput = string> = IExpertAgent<TInput, TOutput>;
