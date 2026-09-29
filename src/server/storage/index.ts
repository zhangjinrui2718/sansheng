export { Storage } from "./db.js";
export { Keyring, isEncrypted, isMaskedApiKey } from "./keyring.js";
export { embedText } from "./embeddings.js";
export type { EmbeddingProvider } from "./embeddings.js";
export { extractFragments } from "./extractor.js";
export type { ExtractedFragment } from "./extractor.js";
export {
  upsertConversation,
  recordMessageUsage,
  setConversationTitle,
  getConversation,
  listConversations,
} from "./repo/conversations.js";
export type { ConversationSummary, ConversationRow } from "./repo/conversations.js";
export { insertMessage, listMessagesByConversation, getMessage } from "./repo/messages.js";
export type { MessageRow } from "./repo/messages.js";
export {
  insertFragment,
  upsertFragmentEmbedding,
  getFragment,
  listFragmentsByKind,
  listFragmentsAll,
  searchFragments,
  searchFragmentsByText,
  recordFragmentAccess,
  isVecAvailable,
} from "./repo/fragments.js";
export type { FragmentRow, FragmentSearchOpts } from "./repo/fragments.js";
export { getProfile, listProfile, upsertProfile, reinforceProfile } from "./repo/profile.js";
export type { ProfileEntry } from "./repo/profile.js";
export { upsertAgentState, getAgentState, deleteAgentState } from "./repo/agentStates.js";
export type { AgentStateRow } from "./repo/agentStates.js";
export {
  upsertBlackboard,
  getBlackboard,
  getActiveBlackboard,
  listBlackboards,
  markBlackboardStatus,
  upsertArtifact,
  getArtifact,
  listArtifacts,
  updateArtifactStatus,
  migrateBlackboardArtifacts,
  applyLegacyMigration,
  validateArtifact,
  GLOBAL_BLACKBOARD_ID,
} from "./repo/blackboards.js";
export type { ListArtifactsOptions } from "./repo/blackboards.js";
export { piMessagesToBlocks } from "./util/blocks.js";