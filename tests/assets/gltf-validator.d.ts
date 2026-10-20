// Types for the parts of the Khronos glTF validator (npm gltf-validator) the asset tests use.
declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    severity: number;
    pointer?: string;
  }
  export interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
      truncated: boolean;
    };
    info?: Record<string, unknown>;
  }
  export function validateBytes(
    data: Uint8Array,
    options?: { maxIssues?: number; ignoredIssues?: string[]; severityOverrides?: Record<string, number> },
  ): Promise<ValidationReport>;
  export function version(): string;
}
