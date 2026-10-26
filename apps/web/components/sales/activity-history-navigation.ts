export function preservesActivityHistory(target: HTMLAnchorElement | HTMLFormElement, assignmentId: string) {
  if (
    !(target instanceof HTMLFormElement) ||
    target.method.toLowerCase() !== "get" ||
    target.dataset.activityHistory !== assignmentId
  )
    return false;
  const url = new URL(target.action, window.location.href);
  return url.origin === window.location.origin && url.pathname === `/sales/assignments/${assignmentId}`;
}
