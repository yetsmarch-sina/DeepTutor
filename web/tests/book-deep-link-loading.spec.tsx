import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookWsEvent } from "@/lib/book-api";

const fixture = vi.hoisted(() => ({
  params: {} as { bookId?: string; pageId?: string },
  get: vi.fn(),
  list: vi.fn(),
  getPage: vi.fn(),
  listLearningCaptures: vi.fn(),
  markVisited: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  notify: vi.fn(),
  health: vi.fn(),
  onBookEvent: null as ((event: BookWsEvent) => void) | null,
  t: (key: string, values?: Record<string, string>) =>
    key.replace(/{{(\w+)}}/g, (_match, name: string) => values?.[name] ?? ""),
}));

vi.mock("next/navigation", () => ({
  useParams: () => fixture.params,
  usePathname: () => "/learning/books",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: fixture.push,
    replace: fixture.replace,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: fixture.t,
  }),
}));

vi.mock("@/lib/notifications", () => ({
  notify: fixture.notify,
}));

vi.mock("@/components/learning/LibraryWorkspace", () => ({
  useLearningCreation: () => ({ begin: vi.fn(), dialog: null }),
  requestedLearningCreation: () => false,
}));

vi.mock("@/lib/book-api", () => ({
  BookApiError: class BookApiError extends Error {
    status = 500;
    code?: string;
  },
  bookApi: {
    get: fixture.get,
    list: fixture.list,
    getPage: fixture.getPage,
    listLearningCaptures: fixture.listLearningCaptures,
    markVisited: fixture.markVisited,
    health: fixture.health,
  },
}));

vi.mock("@/lib/use-book-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-book-stream")>();
  return {
    ...actual,
    useBookStream: (_id: string | null, onEvent: (event: BookWsEvent) => void) => {
      fixture.onBookEvent = onEvent;
    },
  };
});

vi.mock("@/app/(workspace)/learning/books/components/BookLibrary", () => ({
  default: () => <div data-testid="book-library" />,
}));
vi.mock("@/app/(workspace)/learning/books/components/BookCreator", () => ({
  default: () => <div data-testid="book-creator" />,
}));
vi.mock("@/app/(workspace)/learning/books/components/SpineEditor", () => ({
  default: () => <div data-testid="spine-editor" />,
}));
vi.mock("@/app/(workspace)/learning/books/components/BookSidebar", () => ({
  default: () => <div data-testid="book-sidebar" />,
}));
vi.mock("@/app/(workspace)/learning/books/components/BookGenerationActivity", () => ({
  default: () => <div data-testid="book-generation" />,
}));
vi.mock("@/app/(workspace)/learning/books/components/BookPausedBanner", () => ({
  default: () => null,
}));
vi.mock("@/app/(workspace)/learning/books/components/BookChatPanel", () => ({
  default: ({
    book,
    page,
    prefillPrompt,
  }: {
    book: { id: string };
    page: { id: string };
    prefillPrompt?: { text: string } | null;
  }) => (
    <div data-testid="page-chat" data-book-id={book.id} data-page-id={page.id}>
      <textarea aria-label="Page question" readOnly value={prefillPrompt?.text || ""} />
    </div>
  ),
}));
vi.mock("@/app/(workspace)/learning/books/components/LearningCapturePanel", () => ({
  default: () => null,
}));
vi.mock("@/app/(workspace)/learning/books/components/PageReader", () => ({
  default: ({ page, bookId }: { page?: { id: string } | null; bookId?: string }) => (
    <div data-testid="page-reader" data-book-id={bookId}>{page?.id || "no-page"}</div>
  ),
}));

import BookPage from "@/app/(workspace)/learning/books/BooksRoute";

function readyDetail() {
  const progress = {
    current_page_id: null,
    visited_page_ids: [],
    bookmarked_page_ids: [],
    quiz_attempts: {},
  };
  return {
    book: {
      id: "book-1",
      title: "A book",
      status: "ready",
      can_edit: true,
      revision: 1,
      updated_at: 1,
      metadata: {},
    },
    pages: [
      {
        id: "page-1",
        book_id: "book-1",
        title: "Chapter one",
        status: "ready",
        blocks: [],
        block_count: 0,
      },
    ],
    spine: null,
    progress,
    generation: null,
  };
}

beforeEach(() => {
  fixture.params = {};
  fixture.get.mockReset();
  fixture.list.mockReset().mockReturnValue(new Promise(() => undefined));
  fixture.getPage.mockReset();
  fixture.listLearningCaptures
    .mockReset()
    .mockResolvedValue({ captures: [] });
  fixture.markVisited
    .mockReset()
    .mockResolvedValue({ progress: readyDetail().progress });
  fixture.push.mockReset().mockImplementation(() => {
    fixture.params = {};
  });
  fixture.replace.mockReset();
  fixture.notify.mockReset();
  fixture.onBookEvent = null;
  fixture.health.mockReset().mockResolvedValue({
    kb_drift: { has_drift: false },
    log_health: { block_failures: 0 },
    generation: { failed_blocks: 0, failed_pages: 0, failure_categories: {} },
  });
});

describe("book deep-link loading", () => {
  it("refreshes a stale failure banner when generation diagnostics change", async () => {
    fixture.params = { bookId: "book-1" };
    const detail = readyDetail();
    fixture.get.mockResolvedValue(detail);
    fixture.health.mockResolvedValueOnce({
      kb_drift: { has_drift: false },
      log_health: { block_failures: 0 },
      generation: { failed_blocks: 1, failed_pages: 0, failure_categories: {} },
    });
    render(<BookPage />);
    expect(await screen.findByText("1 blocks failed to generate.")).toBeInTheDocument();

    fixture.get.mockResolvedValue({
      ...detail,
      book: { ...detail.book, updated_at: 2 },
    });
    act(() => {
      fixture.onBookEvent?.({
        type: "progress",
        metadata: { kind: "generation_updated", book_id: "book-1" },
      });
    });

    await waitFor(() => {
      expect(fixture.health).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("1 blocks failed to generate.")).not.toBeInTheDocument();
    });
  });

  it("opens the current chapter chat with a visualization follow-up", async () => {
    fixture.params = { bookId: "book-1", pageId: "page-1" };
    fixture.get.mockResolvedValue(readyDetail());
    render(<BookPage />);
    await screen.findByTestId("page-reader");
    expect(screen.queryByTestId("page-chat")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("dt:visualize-prompt", { detail: "Explain parallel attention" }),
      );
    });

    expect(screen.getByTestId("page-chat")).toHaveAttribute("data-book-id", "book-1");
    expect(screen.getByTestId("page-chat")).toHaveAttribute("data-page-id", "page-1");
    expect(screen.getByRole("textbox", { name: "Page question" })).toHaveValue(
      "Explain parallel attention",
    );
  });

  it("ignores empty or malformed visualization follow-ups", async () => {
    fixture.params = { bookId: "book-1" };
    fixture.get.mockResolvedValue(readyDetail());
    render(<BookPage />);
    await screen.findByTestId("page-reader");

    act(() => {
      for (const detail of [" ", { text: "not a prompt" }]) {
        window.dispatchEvent(new CustomEvent("dt:visualize-prompt", { detail }));
      }
    });

    expect(screen.queryByTestId("page-chat")).not.toBeInTheDocument();
  });

  it("keeps a direct book URL in a book loading shell until details arrive", async () => {
    fixture.params = { bookId: "book-1" };
    let resolveDetails!: (value: ReturnType<typeof readyDetail>) => void;
    fixture.get.mockReturnValue(
      new Promise((resolve) => {
        resolveDetails = resolve;
      }),
    );

    render(<BookPage />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("book-library")).not.toBeInTheDocument();
    expect(screen.queryByTestId("book-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("book-generation")).not.toBeInTheDocument();

    await act(async () => {
      resolveDetails(readyDetail());
    });

    expect(await screen.findByTestId("page-reader")).toHaveTextContent("page-1");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("book-library")).not.toBeInTheDocument();
  });

  it("opens the requested page directly after a page deep link loads", async () => {
    fixture.params = { bookId: "book-1", pageId: "page-1" };
    fixture.get.mockResolvedValue(readyDetail());

    render(<BookPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByTestId("page-reader")).toHaveTextContent("page-1");
    expect(screen.queryByTestId("book-library")).not.toBeInTheDocument();
  });

  it("hides the previous book while a client route opens a different book", async () => {
    fixture.params = { bookId: "book-1" };
    let resolveNext!: (value: ReturnType<typeof readyDetail>) => void;
    fixture.get.mockImplementation((id: string) =>
      id === "book-1"
        ? Promise.resolve(readyDetail())
        : new Promise((resolve) => {
            resolveNext = resolve;
          }),
    );
    const { rerender } = render(<BookPage />);
    expect(await screen.findByTestId("page-reader")).toHaveTextContent("page-1");

    fixture.params = { bookId: "book-2" };
    rerender(<BookPage />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("page-reader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("book-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("book-generation")).not.toBeInTheDocument();

    const next = readyDetail();
    next.book.id = "book-2";
    next.pages[0].book_id = "book-2";
    await act(async () => resolveNext(next));
    expect(await screen.findByTestId("page-reader")).toHaveAttribute("data-book-id", "book-2");
  });

  it("ignores an earlier book response that arrives after the new route", async () => {
    fixture.params = { bookId: "book-1" };
    let resolveOld!: (value: ReturnType<typeof readyDetail>) => void;
    const next = readyDetail();
    next.book.id = "book-2";
    next.pages[0].book_id = "book-2";
    fixture.get.mockImplementation((id: string) =>
      id === "book-1"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(next),
    );
    const { rerender } = render(<BookPage />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fixture.params = { bookId: "book-2" };
    rerender(<BookPage />);
    expect(await screen.findByTestId("page-reader")).toHaveAttribute("data-book-id", "book-2");
    await act(async () => resolveOld(readyDetail()));
    expect(screen.getByTestId("page-reader")).toHaveAttribute("data-book-id", "book-2");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("still renders the library at the books root route", async () => {
    let resolveBooks!: (value: { books: never[]; can_create: boolean }) => void;
    fixture.list.mockReturnValue(
      new Promise((resolve) => {
        resolveBooks = resolve;
      }),
    );

    render(<BookPage />);

    expect(screen.getByTestId("book-library")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(async () => {
      resolveBooks({ books: [], can_create: true });
    });
  });

  it("leaves loading and returns to the library when the book cannot be loaded", async () => {
    fixture.params = { bookId: "missing-book" };
    fixture.get.mockRejectedValue(new Error("Book not found"));
    let resolveBooks!: (value: { books: never[]; can_create: boolean }) => void;
    fixture.list.mockReturnValue(
      new Promise((resolve) => {
        resolveBooks = resolve;
      }),
    );

    render(<BookPage />);

    await waitFor(() => {
      expect(fixture.push).toHaveBeenCalledWith("/learning/books");
      expect(screen.getByTestId("book-library")).toBeInTheDocument();
    });
    await act(async () => {
      resolveBooks({ books: [], can_create: true });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(fixture.notify).toHaveBeenCalledWith("Open book failed: Book not found", {
      tone: "error",
      durationMs: 8000,
    });
  });
});
