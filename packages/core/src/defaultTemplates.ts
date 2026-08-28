/**
 * Fallback templates used when a category has no row in `ack_templates` /
 * `relance_templates` yet — what makes the templated accusé work "from day 1"
 * without per-category authoring first (see refonte-plan.md). Editable per
 * category from Settings once a tenant wants to customize; these are the
 * out-of-the-box default, not a hardcoded final answer.
 */
export const DEFAULT_ACK_TEMPLATE: Record<"fr" | "en", string> = {
  fr: [
    "Bonjour{{#senderName}} {{senderName}}{{/senderName}},",
    "",
    "Nous avons bien reçu votre message « {{originalSubject}} ».",
    "{{#summary}}Votre demande concerne : {{summary}}.{{/summary}}",
    "",
    "Notre équipe revient vers vous sous {{sla}} maximum.",
    "",
    "{{signature}}",
  ].join("\n"),
  en: [
    "Hello{{#senderName}} {{senderName}}{{/senderName}},",
    "",
    "We've received your message « {{originalSubject}} ».",
    "{{#summary}}Your request: {{summary}}.{{/summary}}",
    "",
    "Our team will get back to you within {{sla}} at the latest.",
    "",
    "{{signature}}",
  ].join("\n"),
};

export const DEFAULT_RELANCE_TEMPLATE: Record<"pre_reply" | "post_reply", Record<"fr" | "en", string>> = {
  pre_reply: {
    fr: [
      "Bonjour{{#senderName}} {{senderName}}{{/senderName}},",
      "",
      "Nous revenons vers vous au sujet de « {{originalSubject}} » : votre demande est toujours en cours de traitement par notre équipe.",
      "",
      "Merci de votre patience.",
      "",
      "{{signature}}",
    ].join("\n"),
    en: [
      "Hello{{#senderName}} {{senderName}}{{/senderName}},",
      "",
      "Following up on « {{originalSubject}} »: your request is still being handled by our team.",
      "",
      "Thank you for your patience.",
      "",
      "{{signature}}",
    ].join("\n"),
  },
  post_reply: {
    fr: [
      "Bonjour{{#senderName}} {{senderName}}{{/senderName}},",
      "",
      "Nous revenons vers vous au sujet de « {{originalSubject}} » : nous n'avons pas eu de retour de votre part suite à notre précédent message{{#hadAttachment}} (avec pièce jointe){{/hadAttachment}}.",
      "",
      "N'hésitez pas à nous recontacter si vous avez des questions.",
      "",
      "{{signature}}",
    ].join("\n"),
    en: [
      "Hello{{#senderName}} {{senderName}}{{/senderName}},",
      "",
      "Following up on « {{originalSubject}} »: we haven't heard back since our previous message{{#hadAttachment}} (with attachment){{/hadAttachment}}.",
      "",
      "Feel free to reach out with any questions.",
      "",
      "{{signature}}",
    ].join("\n"),
  },
};
