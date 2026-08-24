export function emptyPersonaPlan() {
    return {
        enabled: false,
        seed: "",
        draft: null,
        pairing: { greeting: false, register: "neutral", greeting_text: "" },
    };
}
export const WEAVER_FACT_SOURCES = [
    "extracted",
    "user",
    "picked",
    "enhanced",
];
export const DYNAMIC_TARGET = "dynamic";
export const OPT_IN_PREFIX = "optin";
export const WEAVER_PERSON_TIERS = ["unfleshed", "extra", "named"];
