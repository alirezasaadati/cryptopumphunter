export function signalOutboxKey(chatId, signalId) {
  return `futures:signal-outbox:v1:${String(chatId)}:${String(signalId)}`;
}

export function signalOutboxAction(record) {
  if (record?.status === "ARCHIVED") return "done";
  if (record?.status === "SENDING" || record?.status === "UNCERTAIN") return "reconcile";
  if (record?.status === "SENT" || record?.status === "ARCHIVE_PENDING") return "archive";
  return "send";
}
