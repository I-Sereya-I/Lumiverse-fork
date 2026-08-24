/** Select the only manifest records that may be sent to LumiHub. */
export function selectLumiHubManifestEntries(entries) {
    return entries.filter((entry) => entry.source === "lumihub");
}
