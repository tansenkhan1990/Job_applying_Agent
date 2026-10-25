import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function parsePagination(query: unknown): Pagination {
  const { page, limit } = paginationSchema.parse(query ?? {});
  return { page, limit, skip: (page - 1) * limit };
}

export function paginated<T>(items: T[], total: number, pagination: Pagination) {
  return {
    items,
    total,
    page: pagination.page,
    limit: pagination.limit,
    pages: Math.max(1, Math.ceil(total / pagination.limit)),
  };
}
