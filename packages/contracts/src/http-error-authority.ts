import { z } from "zod";
import { actionAuthorityErrorDetails } from "./action-authority";
import { createErrorRegistry, defineError } from "./error-envelope";

const emptyDetailsSchema = z.strictObject({});

/** The complete public transport and action errors exposed by HTTP consumers. */
export const httpErrorRegistry = createErrorRegistry([
  defineError({ code: "invalid_request", status: 400, details: emptyDetailsSchema }),
  defineError({ code: "missing_credentials", status: 401, details: emptyDetailsSchema }),
  defineError({ code: "invalid_credentials", status: 401, details: emptyDetailsSchema }),
  defineError({ code: "expired_credentials", status: 401, details: emptyDetailsSchema }),
  defineError({ code: "insufficient_scope", status: 403, details: emptyDetailsSchema }),
  defineError({ code: "request_too_large", status: 413, details: emptyDetailsSchema }),
  defineError({ code: "not_found", status: 404, details: emptyDetailsSchema }),
  defineError({ code: "internal_error", status: 500, details: emptyDetailsSchema }),
  defineError({
    code: "action.approval_forbidden",
    status: 403,
    message: "request credentials cannot perform this approval operation",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.approval_presence_required",
    status: 403,
    message: "fresh human-present authentication is required",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_presence_unsupported",
    status: 503,
    message: "secure operator presence is unavailable",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_challenge_capacity",
    status: 429,
    message: "operator challenge capacity is exhausted",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_challenge_not_found",
    status: 404,
    message: "operator challenge was not found",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_challenge_expired",
    status: 409,
    message: "operator challenge has expired",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_challenge_consumed",
    status: 409,
    message: "operator challenge was already consumed",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.operator_assertion_invalid",
    status: 403,
    message: "operator presence assertion is invalid",
    details: actionAuthorityErrorDetails.empty,
  }),
  defineError({
    code: "action.approval_not_found",
    status: 409,
    message: "action approval was not found",
    details: actionAuthorityErrorDetails.approval,
  }),
  defineError({
    code: "action.approval_mismatch",
    status: 409,
    message: "action approval does not match the frozen plan",
    details: actionAuthorityErrorDetails.approval,
  }),
  defineError({
    code: "action.approval_expired",
    status: 409,
    message: "action approval has expired",
    details: actionAuthorityErrorDetails.expiredApproval,
  }),
  defineError({
    code: "action.approval_cancelled",
    status: 409,
    message: "action approval was cancelled",
    details: actionAuthorityErrorDetails.cancelledApproval,
  }),
  defineError({
    code: "action.approval_invalidated",
    status: 409,
    message: "action approval is no longer valid",
    details: actionAuthorityErrorDetails.invalidatedApproval,
  }),
  defineError({
    code: "action.approval_consumed",
    status: 409,
    message: "action approval was already consumed",
    details: actionAuthorityErrorDetails.consumedApproval,
  }),
  defineError({
    code: "action.plan_version_stale",
    status: 409,
    message: "action plan version is stale",
    details: actionAuthorityErrorDetails.planVersion,
  }),
  defineError({
    code: "action.plan_not_pending",
    status: 409,
    message: "action plan is not pending",
    details: actionAuthorityErrorDetails.planState,
  }),
  defineError({
    code: "action.plan_expired",
    status: 409,
    message: "action plan has expired",
    details: actionAuthorityErrorDetails.expiredPlan,
  }),
  defineError({
    code: "action.legacy_authority",
    status: 409,
    message: "action plan lacks trusted approval authority",
    details: actionAuthorityErrorDetails.legacy,
  }),
] as const);
