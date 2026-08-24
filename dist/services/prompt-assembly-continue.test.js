import { describe, expect, test } from "bun:test";
import { finalizeContinuePrompt, isChatHistoryMessage, resolveContinuePostfix, rtrimLastHistoryAssistant, } from "./prompt-assembly.service";
function historyMessage(role, content, id) {
    return {
        role,
        content,
        __chatHistorySource: true,
        __sourceMessageId: id,
    };
}
function continueNudge(content) {
    return {
        role: "system",
        content,
        __continueNudge: true,
    };
}
describe("continue prompt finalization", () => {
    test("preserves the separator and places the target immediately before its nudge", () => {
        const target = historyMessage("assistant", "The door opened", "target");
        const messages = [
            { role: "system", content: "Follow the character card." },
            historyMessage("user", "What is behind it?", "user-1"),
            target,
            { role: "system", content: "Post-history instructions." },
            continueNudge("Continue without repeating the original response."),
        ];
        rtrimLastHistoryAssistant(messages, "target");
        expect(target.content).toBe("The door opened");
        expect(finalizeContinuePrompt(messages, "target", " ")).toBe(true);
        expect(messages.map((message) => message.content)).toEqual([
            "Follow the character card.",
            "What is behind it?",
            "Post-history instructions.",
            "The door opened ",
            "Continue without repeating the original response.",
        ]);
        expect(isChatHistoryMessage(messages[3])).toBe(false);
        expect(isChatHistoryMessage(messages[1])).toBe(true);
    });
    test("does not duplicate a separator that already ends the saved reply", () => {
        expect(resolveContinuePostfix("Already spaced ", " ")).toBe("");
        expect(resolveContinuePostfix("Line one\n", "\n")).toBe("");
        expect(resolveContinuePostfix("No separator", "\n\n")).toBe("\n\n");
        const messages = [historyMessage("assistant", "Already spaced ", "target")];
        rtrimLastHistoryAssistant(messages, "target");
        expect(messages[0].content).toBe("Already spaced ");
        finalizeContinuePrompt(messages, "target", "");
        expect(messages[0].content).toBe("Already spaced ");
    });
    test("leaves a native assistant prefill as the final prompt message", () => {
        const messages = [
            historyMessage("user", "Write a cliffhanger.", "user-1"),
            historyMessage("assistant", "The lights went out", "target"),
        ];
        expect(finalizeContinuePrompt(messages, "target", "\n")).toBe(true);
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({
            role: "assistant",
            content: "The lights went out\n",
        });
        expect(isChatHistoryMessage(messages[1])).toBe(false);
    });
    test("marks a native continue prefill as partial", () => {
        const messages = [
            historyMessage("user", "Write a cliffhanger.", "user-1"),
            historyMessage("assistant", "The lights went out", "target"),
        ];
        expect(finalizeContinuePrompt(messages, "target", "\n", true)).toBe(true);
        expect(messages[1]).toMatchObject({
            role: "assistant",
            content: "The lights went out\n",
            partial: true,
        });
    });
});
