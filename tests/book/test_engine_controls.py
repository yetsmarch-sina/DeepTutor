from __future__ import annotations

import pytest

from deeptutor.book import engine as engine_module
from deeptutor.book.engine import BookEngine
from deeptutor.book.models import (
    Block,
    BlockStatus,
    BlockType,
    Book,
    BookStatus,
    Page,
    PageStatus,
)
from deeptutor.runtime.stream_bus import StreamBus


def test_force_compile_reset_preserves_user_notes() -> None:
    generated = Block(
        type=BlockType.CODE,
        status=BlockStatus.READY,
        payload={"code": "print(1)"},
        source_anchors=[],
        metadata={"generation_ms": 10, "transition_in": "bridge"},
    )
    note = Block(
        type=BlockType.USER_NOTE,
        status=BlockStatus.READY,
        payload={"body": "keep me"},
    )
    page = Page(status=PageStatus.READY, error="", blocks=[generated, note])

    BookEngine._reset_page_for_force_compile(page)

    assert page.status == PageStatus.PENDING
    assert generated.status == BlockStatus.PENDING
    assert generated.payload == {}
    assert generated.error == ""
    assert generated.metadata == {"transition_in": "bridge"}
    assert note.status == BlockStatus.READY
    assert note.payload == {"body": "keep me"}


class _RecordingStorage:
    """Minimal stand-in for BookStorage: records or refuses save_page calls."""

    def __init__(self, fail: bool = False):
        self.saved: list[Page] = []
        self.fail = fail

    def save_page(self, page: Page) -> None:
        if self.fail:
            raise OSError("disk full")
        self.saved.append(page)


def _engine_with_storage(storage: _RecordingStorage) -> BookEngine:
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    return engine


def test_mark_page_error_resets_generating_page() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)
    page = Page(status=PageStatus.GENERATING)

    engine._mark_page_error(page, RuntimeError("llm timeout"), prefix="Compilation failed")

    assert page.status == PageStatus.ERROR
    assert "llm timeout" in page.error
    assert storage.saved == [page]


def test_mark_page_error_resets_planning_page() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)
    page = Page(status=PageStatus.PLANNING)

    engine._mark_page_error(page, RuntimeError("planner crashed"), prefix="Compilation failed")

    assert page.status == PageStatus.ERROR
    assert "planner crashed" in page.error
    assert storage.saved == [page]


def test_mark_page_error_ignores_missing_or_settled_pages() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)

    engine._mark_page_error(None, RuntimeError("boom"), prefix="x")
    ready = Page(status=PageStatus.READY)
    engine._mark_page_error(ready, RuntimeError("boom"), prefix="x")

    assert storage.saved == []
    assert ready.status == PageStatus.READY


def test_mark_page_error_survives_save_failure() -> None:
    engine = _engine_with_storage(_RecordingStorage(fail=True))
    page = Page(status=PageStatus.GENERATING)

    # Runs inside exception handlers (worker loop) — must never raise.
    engine._mark_page_error(page, RuntimeError("boom"), prefix="x")

    assert page.status == PageStatus.ERROR


class _GenerationStorage:
    def __init__(self, book: Book, pages: list[Page]) -> None:
        self.book = book
        self.pages = pages
        self.saved_books: list[Book] = []

    def load_book(self, book_id: str) -> Book | None:
        return self.book

    def list_pages(self, book_id: str) -> list[Page]:
        return self.pages

    def save_book(self, book: Book) -> None:
        self.saved_books.append(book.model_copy(deep=True))

    def append_log(self, book_id: str, message: str, *, op: str) -> None:
        pass


class _LiveRuntime:
    """Stands in for ``_BookRuntime`` with a worker that has not finished."""

    class _Pending:
        @staticmethod
        def done() -> bool:
            return False

    worker = _Pending()
    in_flight: dict[str, object] = {}


def test_generation_summary_classifies_retryable_failures() -> None:
    book = Book(id="bk", status=BookStatus.PAUSED, metadata={"pause_reason": "quota"})
    pages = [
        Page(id="ready", status=PageStatus.READY),
        Page(id="pending", status=PageStatus.PENDING),
        Page(
            id="failed",
            status=PageStatus.ERROR,
            error="429 rate limit",
            blocks=[
                Block(
                    type=BlockType.TEXT,
                    status=BlockStatus.ERROR,
                    error="provider timeout",
                )
            ],
        ),
    ]
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _GenerationStorage(book, pages)

    summary = engine.generation_summary("bk")

    assert summary["pages"]["ready"] == 1
    assert summary["pages"]["pending"] == 1
    assert summary["pages"]["error"] == 1
    assert summary["retryable_pages"] == 2
    assert summary["failed_blocks"] == 1
    assert summary["can_resume"] is True
    assert summary["failure_categories"] == {"rate_limit": 1, "provider": 1}


def test_generation_summary_does_not_flag_a_queue_as_retryable() -> None:
    """A book being compiled right now owes chapters; it has not failed any.

    Counting the queue as "retryable" is what made a healthy book raise a
    failure warning ("3 chapters can be retried") the moment generation
    started, on zero errors.
    """

    book = Book(id="bk", status=BookStatus.COMPILING)
    pages = [
        Page(id="ready", status=PageStatus.READY),
        Page(id="queued", status=PageStatus.PENDING),
        Page(id="working", status=PageStatus.GENERATING),
    ]
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _GenerationStorage(book, pages)
    engine._runtimes = {"bk": _LiveRuntime()}

    summary = engine.generation_summary("bk")

    assert summary["working"] is True
    assert summary["interrupted"] is False
    assert summary["queued_pages"] == 2
    assert summary["failed_pages"] == 0
    assert summary["retryable_pages"] == 0
    assert summary["can_resume"] is False


def test_generation_summary_surfaces_an_abandoned_compile() -> None:
    """``status == compiling`` outlives the process that set it.

    With no worker behind it the queue is not going to move on its own, so the
    owed chapters become the reader's problem and need the manual way out.
    """

    book = Book(id="bk", status=BookStatus.COMPILING)
    pages = [
        Page(id="ready", status=PageStatus.READY),
        Page(id="queued", status=PageStatus.PENDING),
    ]
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _GenerationStorage(book, pages)
    engine._runtimes = {}

    summary = engine.generation_summary("bk")

    assert summary["working"] is False
    assert summary["interrupted"] is True
    assert summary["retryable_pages"] == 1
    assert summary["can_resume"] is True


def test_on_demand_book_waiting_for_a_chapter_is_not_interrupted() -> None:
    book = Book(id="bk", status=BookStatus.COMPILING, metadata={"lazy_compile": True})
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _GenerationStorage(
        book,
        [Page(status=PageStatus.READY), Page(status=PageStatus.PENDING)],
    )
    engine._runtimes = {}

    summary = engine.generation_summary("bk")

    assert summary["working"] is False
    assert summary["interrupted"] is False
    assert summary["queued_pages"] == 1
    assert summary["retryable_pages"] == 0
    assert summary["can_resume"] is False


@pytest.mark.parametrize("status", [PageStatus.PLANNING, PageStatus.GENERATING])
def test_on_demand_book_still_reports_an_abandoned_active_chapter(status: PageStatus) -> None:
    book = Book(id="bk", status=BookStatus.COMPILING, metadata={"lazy_compile": True})
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _GenerationStorage(
        book,
        [Page(status=status), Page(status=PageStatus.PENDING)],
    )
    engine._runtimes = {}

    summary = engine.generation_summary("bk")

    assert summary["interrupted"] is True
    assert summary["retryable_pages"] == 1
    assert summary["can_resume"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("other_page_status", [PageStatus.PENDING, PageStatus.READY])
async def test_chapter_recovery_updates_book_diagnostics_and_publishes_after_save(
    monkeypatch: pytest.MonkeyPatch, other_page_status: PageStatus
) -> None:
    book = Book(
        id="bk",
        status=BookStatus.COMPILING,
        updated_at=1,
        metadata={"lazy_compile": True},
    )
    block = Block(type=BlockType.CALLOUT, status=BlockStatus.ERROR, error="empty response")
    page = Page(status=PageStatus.PARTIAL, blocks=[block])
    storage = _GenerationStorage(book, [page, Page(status=other_page_status)])
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    bus = StreamBus()
    monkeypatch.setattr(engine_module, "get_book_bus", lambda _: bus)
    monkeypatch.setattr(engine_module.time, "time", lambda: 100.0)
    assert engine.generation_summary("bk")["failed_blocks"] == 1

    block.status = BlockStatus.READY
    block.error = ""
    page.status = PageStatus.READY
    await engine._maybe_finalize_book("bk")

    assert storage.saved_books[-1].updated_at == 100.0
    assert engine.generation_summary("bk")["failed_blocks"] == 0
    completed = other_page_status == PageStatus.READY
    assert book.status == (BookStatus.READY if completed else BookStatus.COMPILING)
    assert bus._history[-1].metadata["kind"] == (
        "book_ready" if completed else "generation_updated"
    )
