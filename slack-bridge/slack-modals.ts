export type SlackModalView = Record<string, unknown>;

export interface SlackModalOptionInput {
  text: string;
  value: string;
}

export interface SlackModalFieldInput {
  label: string;
  action_id: string;
  block_id?: string;
  placeholder?: string;
  hint?: string;
  initial_value?: string;
  multiline?: boolean;
  optional?: boolean;
}

export interface SlackModalTemplateInput {
  template: string;
  title?: string;
  submit_label?: string;
  close_label?: string;
  callback_id?: string;
  external_id?: string;
  private_metadata?: string;
  text?: string;
  confirm_phrase?: string;
  confirm_label?: string;
  confirm_action_id?: string;
  confirm_placeholder?: string;
  fields?: SlackModalFieldInput[];
  label?: string;
  action_id?: string;
  placeholder?: string;
  options?: SlackModalOptionInput[];
  initial_values?: string[];
  max_selected_items?: number;
  optional?: boolean;
}

export interface SlackModalTemplateResult {
  view: SlackModalView;
  summary: string;
}

const PI_SLACK_MODAL_CONTEXT_KEY = "__piSlackModalContext";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePlainText(text: string | undefined, fallback: string, maxLength: number): string {
  const value = (text?.trim() || fallback).slice(0, maxLength);
  if (!value) {
    throw new Error("Slack modal text values must not be empty.");
  }
  return value;
}

function plainText(text: string, maxLength = 75): Record<string, unknown> {
  return {
    type: "plain_text",
    text: normalizePlainText(text, text, maxLength),
  };
}

function buildBaseModalView(input: SlackModalTemplateInput): SlackModalView {
  const view: SlackModalView = {
    type: "modal",
    title: plainText(input.title ?? "Modal", 24),
    close: plainText(input.close_label ?? "Cancel", 24),
    blocks: [],
  };

  const submitLabel = input.submit_label?.trim();
  if (submitLabel) {
    view.submit = plainText(submitLabel, 24);
  }
  if (input.callback_id?.trim()) {
    view.callback_id = input.callback_id.trim();
  }
  if (input.external_id?.trim()) {
    view.external_id = input.external_id.trim();
  }
  if (input.private_metadata != null) {
    view.private_metadata = String(input.private_metadata);
  }
  return view;
}

function buildConfirmationModal(input: SlackModalTemplateInput): SlackModalTemplateResult {
  if (!input.text?.trim()) {
    throw new Error('Template "confirmation" requires text.');
  }

  const view = buildBaseModalView({
    ...input,
    title: input.title ?? "Confirm action",
    submit_label: input.submit_label ?? "Confirm",
    close_label: input.close_label ?? "Cancel",
  });

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: input.text.trim(),
      },
    },
  ];

  if (input.confirm_phrase?.trim()) {
    blocks.push({
      type: "input",
      block_id: "confirm_phrase",
      label: plainText(
        input.confirm_label ?? `Type ${input.confirm_phrase.trim()} to continue`,
        2000,
      ),
      element: {
        type: "plain_text_input",
        action_id: input.confirm_action_id?.trim() || "confirm_phrase",
        placeholder: plainText(input.confirm_placeholder ?? input.confirm_phrase.trim(), 150),
      },
    });
  }

  view.blocks = blocks;
  return {
    view,
    summary: `Built confirmation modal ${JSON.stringify(asString(view.callback_id) ?? asString(view.external_id) ?? "modal")}.`,
  };
}

function buildFormModal(input: SlackModalTemplateInput): SlackModalTemplateResult {
  const fields = input.fields ?? [];
  if (fields.length === 0) {
    throw new Error('Template "form" requires at least one field.');
  }

  const view = buildBaseModalView({
    ...input,
    title: input.title ?? "Form",
    submit_label: input.submit_label ?? "Submit",
    close_label: input.close_label ?? "Cancel",
  });

  view.blocks = fields.map((field, index) => {
    const element: Record<string, unknown> = {
      type: "plain_text_input",
      action_id: field.action_id.trim(),
      ...(field.placeholder?.trim() ? { placeholder: plainText(field.placeholder, 150) } : {}),
      ...(field.initial_value?.trim() ? { initial_value: field.initial_value } : {}),
      ...(field.multiline ? { multiline: true } : {}),
    };

    const block: Record<string, unknown> = {
      type: "input",
      block_id: field.block_id?.trim() || field.action_id.trim() || `field_${index + 1}`,
      label: plainText(field.label, 2000),
      element,
    };
    if (field.hint?.trim()) {
      block.hint = plainText(field.hint, 2000);
    }
    if (field.optional) {
      block.optional = true;
    }
    return block;
  });

  return {
    view,
    summary: `Built form modal with ${fields.length} field${fields.length === 1 ? "" : "s"}.`,
  };
}

function buildMultiSelectModal(input: SlackModalTemplateInput): SlackModalTemplateResult {
  const label = input.label?.trim();
  const actionId = input.action_id?.trim();
  const options = input.options ?? [];
  if (!label) {
    throw new Error('Template "multi_select" requires label.');
  }
  if (!actionId) {
    throw new Error('Template "multi_select" requires action_id.');
  }
  if (options.length === 0) {
    throw new Error('Template "multi_select" requires at least one option.');
  }

  const optionLookup = new Map(options.map((option) => [option.value, option] as const));
  const initialOptions = (input.initial_values ?? [])
    .map((value) => optionLookup.get(value))
    .filter((option): option is SlackModalOptionInput => Boolean(option))
    .map((option) => ({
      text: plainText(option.text, 75),
      value: option.value,
    }));

  const view = buildBaseModalView({
    ...input,
    title: input.title ?? "Choose options",
    submit_label: input.submit_label ?? "Submit",
    close_label: input.close_label ?? "Cancel",
  });

  view.blocks = [
    {
      type: "input",
      block_id: actionId,
      label: plainText(label, 2000),
      optional: input.optional === true,
      element: {
        type: "multi_static_select",
        action_id: actionId,
        placeholder: plainText(input.placeholder ?? "Select one or more options", 150),
        options: options.map((option) => ({
          text: plainText(option.text, 75),
          value: option.value,
        })),
        ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
        ...(input.max_selected_items != null
          ? { max_selected_items: input.max_selected_items }
          : {}),
      },
    },
  ];

  return {
    view,
    summary: `Built multi-select modal with ${options.length} option${options.length === 1 ? "" : "s"}.`,
  };
}

export function buildSlackModalTemplate(input: SlackModalTemplateInput): SlackModalTemplateResult {
  switch (input.template) {
    case "confirmation":
      return buildConfirmationModal(input);
    case "form":
      return buildFormModal(input);
    case "multi_select":
      return buildMultiSelectModal(input);
    default:
      throw new Error(
        `Unknown modal template ${JSON.stringify(input.template)}. Use one of: confirmation, form, multi_select.`,
      );
  }
}

export function normalizeSlackModalViewInput(view: unknown): SlackModalView {
  if (!isRecord(view)) {
    throw new Error("Slack modal view must be a JSON object.");
  }
  const cloned = structuredClone(view) as SlackModalView;
  if ((cloned.type as string | undefined) !== "modal") {
    throw new Error('Slack modal view.type must be "modal".');
  }
  return cloned;
}

export function buildSlackModalPromptGuidelines(): string[] {
  return [
    "Use Slack modals when you need structured input, explicit approvals, or multi-step workflows instead of free-form thread replies.",
    "slack_modal_open and slack_modal_push require a fresh trigger_id from a recent Slack interaction; trigger IDs expire after about 3 seconds.",
    "If you want a modal submission routed back into the original Slack thread, pass thread_ts when opening/pushing the modal so the bridge can store thread context in private_metadata.",
    "Use slack_modal_build for common confirmation dialogs, forms, and multi-select workflows before opening or updating a modal.",
  ];
}

export interface SlackModalThreadContext {
  threadTs: string;
  channel: string;
}

export interface DecodedSlackModalPrivateMetadata {
  raw: string | null;
  value: unknown;
  threadContext: SlackModalThreadContext | null;
}

export function encodeSlackModalPrivateMetadata(
  privateMetadata: string | undefined,
  threadContext: SlackModalThreadContext | null,
): string | undefined {
  if (!threadContext) {
    return privateMetadata;
  }

  const raw = privateMetadata?.trim();
  let value: unknown = raw ?? null;
  if (raw) {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = raw;
    }
  }

  if (isRecord(value)) {
    return JSON.stringify({
      ...value,
      [PI_SLACK_MODAL_CONTEXT_KEY]: threadContext,
    });
  }

  return JSON.stringify({
    [PI_SLACK_MODAL_CONTEXT_KEY]: threadContext,
    value,
  });
}

export function decodeSlackModalPrivateMetadata(
  privateMetadata: string | undefined,
): DecodedSlackModalPrivateMetadata {
  const raw = asOptionalString(privateMetadata);
  if (!raw) {
    return { raw, value: null, threadContext: null };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const context = parsed[PI_SLACK_MODAL_CONTEXT_KEY];
      const threadContext = isRecord(context)
        ? {
            threadTs: asString(context.threadTs) ?? "",
            channel: asString(context.channel) ?? "",
          }
        : null;
      const normalizedContext =
        threadContext && threadContext.threadTs && threadContext.channel ? threadContext : null;

      if (PI_SLACK_MODAL_CONTEXT_KEY in parsed) {
        const clone = { ...parsed };
        delete clone[PI_SLACK_MODAL_CONTEXT_KEY];
        const userValue = Object.keys(clone).length === 1 && "value" in clone ? clone.value : clone;
        return {
          raw,
          value: userValue,
          threadContext: normalizedContext,
        };
      }

      return { raw, value: parsed, threadContext: normalizedContext };
    }

    return { raw, value: parsed, threadContext: null };
  } catch {
    return { raw, value: raw, threadContext: null };
  }
}
