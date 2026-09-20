/**
 * The single response contract for every tool exposed by the gateway.
 * Any tool (from any provider) returns exactly this shape.
 */
export type ToolErrorCategory = 'transient' | 'validation' | 'business' | 'permission';

export type ToolResponse<T = unknown> = {
  isError: boolean;
  errorCategory?: ToolErrorCategory | null;
  isRetryable?: boolean | null;
  message: string;
  userFriendlyMessage: string;
  data?: T | null;
};

/** Categories that, by nature, are worth a retry from the agent. */
const RETRYABLE_BY_DEFAULT: Record<ToolErrorCategory, boolean> = {
  transient: true,
  validation: false,
  business: false,
  permission: false,
};

export function isRetryableCategory(category: ToolErrorCategory): boolean {
  return RETRYABLE_BY_DEFAULT[category];
}

export function success<T>(params: {
  message: string;
  userFriendlyMessage: string;
  data?: T | null;
}): ToolResponse<T> {
  return {
    isError: false,
    errorCategory: null,
    isRetryable: null,
    message: params.message,
    userFriendlyMessage: params.userFriendlyMessage,
    data: params.data ?? null,
  };
}

export function failure<T = never>(params: {
  errorCategory: ToolErrorCategory;
  message: string;
  userFriendlyMessage: string;
  isRetryable?: boolean;
  data?: T | null;
}): ToolResponse<T> {
  return {
    isError: true,
    errorCategory: params.errorCategory,
    isRetryable: params.isRetryable ?? isRetryableCategory(params.errorCategory),
    message: params.message,
    userFriendlyMessage: params.userFriendlyMessage,
    data: params.data ?? null,
  };
}
