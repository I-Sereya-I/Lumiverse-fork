// ============================================================================
// TOKEN TYPES
// ============================================================================
export var TokenType;
(function (TokenType) {
    TokenType[TokenType["TEXT"] = 0] = "TEXT";
    TokenType[TokenType["MACRO_OPEN"] = 1] = "MACRO_OPEN";
    TokenType[TokenType["MACRO_CLOSE"] = 2] = "MACRO_CLOSE";
    TokenType[TokenType["IDENTIFIER"] = 3] = "IDENTIFIER";
    TokenType[TokenType["SEPARATOR"] = 4] = "SEPARATOR";
    TokenType[TokenType["FLAG_IMMEDIATE"] = 5] = "FLAG_IMMEDIATE";
    TokenType[TokenType["FLAG_DELAYED"] = 6] = "FLAG_DELAYED";
    TokenType[TokenType["FLAG_REEVALUATE"] = 7] = "FLAG_REEVALUATE";
    TokenType[TokenType["FLAG_FILTER"] = 8] = "FLAG_FILTER";
    TokenType[TokenType["FLAG_CLOSE"] = 9] = "FLAG_CLOSE";
    TokenType[TokenType["FLAG_PRESERVE"] = 10] = "FLAG_PRESERVE";
    TokenType[TokenType["DOT"] = 11] = "DOT";
    TokenType[TokenType["DOLLAR"] = 12] = "DOLLAR";
    TokenType[TokenType["AT"] = 13] = "AT";
    TokenType[TokenType["OPERATOR"] = 14] = "OPERATOR";
    TokenType[TokenType["ESCAPED_BRACE"] = 15] = "ESCAPED_BRACE";
    TokenType[TokenType["EOF"] = 16] = "EOF";
})(TokenType || (TokenType = {}));
