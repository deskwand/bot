export const member = {
  bindPage: {
    title: "Bind WeChat",
    reading: "Reading the invitation…",
    incomplete: "This link is incomplete. Ask the person who invited you for a new one.",
    askPin: "Enter the 6-digit code shown in WeChat.",
    needOperator: "The person who invited you must finish verification first.",
    scan: "Scan the QR code with WeChat and confirm.",
    done: "Binding complete.",
    saving: "Finishing the binding…",
    dead: "This invitation is no longer valid. Ask for a new one.",
    unreadable: "Could not read the invitation. Try again shortly.",
    badPin: "The PIN must be 6 digits.",
    pinFailed: "That PIN did not work. Try again.",
    pinLabel: "PIN",
    submit: "Submit",
    qrLabel: "WeChat binding QR code",
  },
  denied: "Only the owner can manage members.",
  localOnly:
    "Note: this deployment has no public address, so this localhost link opens only on the machine running it. Open it yourself and show the QR code on screen; a remote invitee needs a public address configured first.",
  operatorAuth:
    "WeChat requires the person who started this invite to finish real-name verification. Open the link below in WeChat and approve it within {minutes} minutes; the binding QR code is issued only after that:\n{url}",
  error: "Member management failed ({code}).",
  inviteCreated:
    "Binding invite created ({inviteId}), valid until {expiresAt}. Forward this link to the invitee as-is; it walks them through binding WeChat:",
  rebindCreated:
    "Replacement invite created ({inviteId}), valid until {expiresAt}). Forward this link to that member; they must scan with their existing WeChat account:",
  cancelled: "Cancelled invite {inviteId}.",
  revoked:
    "Revoked member {memberId}. Its WeChat connection is disconnected; history is kept.",
  list: {
    empty: "There are no members yet, only the owner.",
    header: "Members ({count}):",
    line: "- {label} ({memberId}): {role}, {status}",
    owner: "owner",
    member: "member",
    active: "active",
    revoked: "revoked",
  },
  share: {
    prepared:
      "Share preview ({shareId}) to {recipient}, valid until {expiresAt}.\nText: {text}\nFiles: {files}\nNothing has been sent yet. Reply 确认分享 {shareId} to confirm, or 取消分享 {shareId} to cancel.",
    noFiles: "none",
    noText: "none",
    confirmed: "Delivered {shareId} to the recipient: {count} items.",
    cancelled: "Cancelled share {shareId}.",
    notFound:
      "That share does not exist, or it was already confirmed, cancelled or expired.",
    errors: {
      MEMBER_ACCESS_DENIED: "These attachments are not yours, so they cannot be shared.",
      SHARE_NOT_FOUND:
        "That share does not exist, or it was already confirmed, cancelled or expired.",
      SHARE_RECIPIENT_UNKNOWN: "No such recipient. Check the name.",
      SHARE_RECIPIENT_AMBIGUOUS:
        "More than one member has that name. Say which one (full WeChat name or member id).",
      SHARE_EMPTY: "A share needs at least a message or one attachment.",
      SHARE_TOO_MANY_FILES: "At most 5 attachments per share.",
      SHARE_TOO_LARGE: "The attachments total more than 15MB. Share them in parts.",
      SHARE_ATTACHMENT_MISSING: "One attachment no longer exists. Prepare it again.",
      SHARE_DIGEST_MISMATCH:
        "An attachment changed after the preview, so this share was voided. Prepare it again.",
      SHARE_EXPIRED: "This share is past its 10-minute window. Prepare it again.",
      SHARE_INVALID:
        "This share is no longer valid (the sender or recipient changed). Prepare it again.",
      SHARE_INTERRUPTED:
        "Delivery failed midway. This share stopped and will not be retried automatically.",
      SHARE_INTERNAL: "Sharing failed. Try again shortly.",
    },
  },
  errors: {
    MEMBER_ACCESS_DENIED: "Only the owner can manage members.",
    INVITE_NOT_FOUND: "That invite does not exist; it may be cancelled or gone.",
    INVITE_EXPIRED: "That invite expired. Create a new one.",
    INVITE_CANCELLED: "That invite was cancelled. Create a new one.",
    INVITE_CONSUMED: "That invite was already used and cannot be reused.",
    USER_ALREADY_BOUND: "That WeChat account is already bound to a member.",
  },
} as const;
