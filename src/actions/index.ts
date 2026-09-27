export * from "./requestPayment.js";
export * from "./sendInvoice.js";
export * from "./postCard.js";
export * from "./askHuman.js";

import { saltRequestPaymentAction } from "./requestPayment.js";
import { saltSendInvoiceAction } from "./sendInvoice.js";
import { saltPostCardAction } from "./postCard.js";
import { saltAskHumanAction } from "./askHuman.js";

export const saltActions = [saltRequestPaymentAction, saltSendInvoiceAction, saltPostCardAction, saltAskHumanAction];
