import { searchWeb } from "../web-search.service";
const hostToolExecutors = new Map([
    [
        "web_search",
        async ({ userId, args }) => {
            const query = typeof args.query === "string" ? args.query.trim() : "";
            if (!query) {
                throw new Error("Web Search requires a non-empty query");
            }
            const requestedCount = typeof args.result_count === "number"
                ? args.result_count
                : typeof args.result_count === "string"
                    ? Number(args.result_count)
                    : undefined;
            const result = await searchWeb(userId, query, requestedCount);
            return result.context;
        },
    ],
]);
export function registerHostCouncilTool(name, executor) {
    hostToolExecutors.set(name, executor);
}
export async function executeHostCouncilTool(input) {
    const executor = hostToolExecutors.get(input.tool.name);
    if (!executor) {
        throw new Error(`Host council tool \"${input.tool.displayName}\" is not registered`);
    }
    return executor(input);
}
