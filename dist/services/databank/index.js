/**
 * Databank — Public API surface.
 *
 * Single entry point for all databank operations: CRUD, document processing,
 * retrieval, scope resolution, and mention handling.
 */
// CRUD
export { createDatabank, listDatabanks, getDatabank, updateDatabank, deleteDatabank, createDocument, listDocuments, getDocument, ensureChatDatabank, renameDocument, getDocumentBySlug, searchDocumentsBySlug, deleteDocument, updateDocumentFile, updateDocumentStatus, insertChunks, getChunksForDocument, getDocumentContent, getFullDocumentText, } from "./databank-crud.service";
// Document processing
export { parseDocument, isSupportedFormat, getSupportedExtensions } from "./document-parser.service";
export { chunkDocument } from "./document-chunker.service";
export { processDocument, abortDocumentProcessing, abortDatabankProcessing, deleteDocumentVectors, deleteDatabankVectors, } from "./vectorization.service";
export { DATABANK_SETTINGS_KEY, DEFAULT_DATABANK_SETTINGS, normalizeDatabankSettings, loadDatabankSettings, saveDatabankSettings, } from "./databank-settings.service";
// Retrieval
export { searchDatabanks, searchDirect, getCachedDatabankResult, clearCache, invalidateDatabankCache, } from "./retrieval.service";
// Scope resolution
export { resolveActiveDatabankIds } from "./scope-resolver.service";
// Mention resolution
export { extractMentionSlugs, stripMentions, lookupSlugsInScope, resolveSlugContent, formatMentionsAsAppendix, clearResolveCache, } from "./mention-resolver.service";
// Web scraping
export { scrapeUrl, ScrapeError } from "./web-scraper.service";
// Fuse
export { fuseDatabanks, FuseError } from "./fuse.service";
