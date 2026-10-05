/** The server's inbound side: frame parsing, the per-connection budget and the text rule. */
export { Budget, createBudget } from './Budget.js';
export type { BudgetOptions } from './Budget.js';
export { InboundParser, parseClientFrame } from './InboundParser.js';
export type { BadReason, InboundFrame } from './InboundParser.js';
export { createTextLimit, TextLimit } from './TextLimit.js';
export type { TextCounts, TextLimitOptions, TextVerdict } from './TextLimit.js';
