export * from "./requestPayment";
export * from "./sendInvoice";
export * from "./postCard";
export * from "./askHuman";

import { saltRequestPaymentAction } from "./requestPayment";
import { saltSendInvoiceAction } from "./sendInvoice";
import { saltPostCardAction } from "./postCard";
import { saltAskHumanAction } from "./askHuman";

export const saltActions = [saltRequestPaymentAction, saltSendInvoiceAction, saltPostCardAction, saltAskHumanAction];
