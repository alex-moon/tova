export const LIST_PAGE_SIZE = 20;

/* Fetch-one-extra cursor paging shared by the tasks and assets lists. */
// @see #255 #398
export const cursorPage = <T extends { _id: { toString(): string } }>(
  docs: T[],
  pageSize: number = LIST_PAGE_SIZE,
): { page: T[]; nextCursor: string | null } => {
  const hasMore = docs.length > pageSize;
  const page = hasMore ? docs.slice(0, pageSize) : docs;
  return {
    page,
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
  };
};
