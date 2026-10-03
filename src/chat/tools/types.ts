import { PoznoteClient } from '../../api/client';
import { ChatToolSpec } from '../../api/chat';
import { ToolArgs } from '../toolHelpers';

/** Agent tool: a spec for the model + an executor on top of the Poznote API. */
export interface PoznoteTool {
  spec: ChatToolSpec;
  /** true — user confirmation is required before execution. */
  requiresApproval?: boolean;
  /** Text for the confirmation card (called before run). */
  approvalPreview?: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
  run: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
}
