import { BATCH_TOOLS } from './batch';
import { FOLDER_TOOLS } from './folders';
import { MISC_TOOLS } from './misc';
import { NOTE_TOOLS } from './notes';
import { SMART_TOOLS } from './smart';
import { TRASH_TOOLS } from './trash';
import { PoznoteTool } from './types';

/** Каталог инструментов агента (30 штук), сгруппированных по доменам. */
export const POZNOTE_TOOLS: PoznoteTool[] = [
  ...NOTE_TOOLS,
  ...TRASH_TOOLS,
  ...FOLDER_TOOLS,
  ...BATCH_TOOLS,
  ...MISC_TOOLS,
  ...SMART_TOOLS,
];

export type { PoznoteTool } from './types';
