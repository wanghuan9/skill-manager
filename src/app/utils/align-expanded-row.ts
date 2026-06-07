import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";

const EXPANDED_ROW_TOP_OFFSET_PX = 18;

function findScrollContainer(element: HTMLElement) {
  const pageContent = element.closest(".page-content");
  if (pageContent instanceof HTMLElement) {
    return pageContent;
  }

  let currentElement = element.parentElement;
  while (currentElement) {
    const hasScrollableContent = currentElement.scrollHeight > currentElement.clientHeight;
    if (hasScrollableContent) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return null;
}

export async function alignExpandedRowIntoView(rowElement: HTMLElement | null) {
  if (!(rowElement instanceof HTMLElement)) {
    return;
  }

  const scrollContainer = findScrollContainer(rowElement);
  if (!(scrollContainer instanceof HTMLElement)) {
    return;
  }

  await waitForNextPaint();

  const containerTop = scrollContainer.getBoundingClientRect().top;
  const containerBottom = scrollContainer.getBoundingClientRect().bottom;
  const rowTop = rowElement.getBoundingClientRect().top;
  const rowBottom = rowElement.getBoundingClientRect().bottom;
  const targetTop = containerTop + EXPANDED_ROW_TOP_OFFSET_PX;

  const isFullyVisibleInCurrentViewport =
    rowTop >= targetTop && rowBottom <= containerBottom;
  if (isFullyVisibleInCurrentViewport) {
    return;
  }

  const scrollDelta = rowTop - targetTop;

  if (Math.abs(scrollDelta) > 1) {
    scrollContainer.scrollTop += scrollDelta;
  }
}
