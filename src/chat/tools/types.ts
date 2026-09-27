import { PoznoteClient } from '../../api/client';
import { ChatToolSpec } from '../../api/chat';
import { ToolArgs } from '../toolHelpers';

/** Инструмент агента: спецификация для модели + исполнитель поверх Poznote API. */
export interface PoznoteTool {
  spec: ChatToolSpec;
  /** true — перед выполнением требуется подтверждение пользователя. */
  requiresApproval?: boolean;
  /** Текст для карточки подтверждения (вызывается до run). */
  approvalPreview?: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
  run: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
}
