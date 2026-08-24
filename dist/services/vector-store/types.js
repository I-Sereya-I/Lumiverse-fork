/**
 * Vector store abstraction — provider-neutral contract.
 *
 * Lumiverse defaults to LanceDB (embedded, on-disk) but can be pointed at an
 * external Qdrant or Milvus cluster for power-user / self-hosted scale. Every
 * provider implements {@link VectorStore}; the ONLY place a provider's client
 * SDK is imported is its own file under `providers/`.
 *
 * Embedding *generation* (the HTTP calls that produce vectors) is orthogonal to
 * storage and stays in `embeddings.service.ts` — vectors are derived; SQLite is
 * the source of truth.
 */
export {};
