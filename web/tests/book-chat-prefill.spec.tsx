import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import BookChatPanel from '@/app/(workspace)/learning/books/components/BookChatPanel'
import type { Book, Page } from '@/lib/book-types'

const fixture = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/context/AppShellContext', () => ({
  useAppShell: () => ({ language: 'en' }),
}))
vi.mock('@/components/common/AssistantResponse', () => ({
  default: () => null,
}))
vi.mock('@/lib/attachment-limits', () => ({
  useAttachmentLimits: () => ({ maxFileBytes: 20_000_000, maxTotalBytes: 25_000_000 }),
}))
vi.mock('@/features/chat/transport/UnifiedTurnClient', () => ({
  UnifiedTurnClient: class {
    constructor() {
      fixture.createClient()
    }
  },
}))

const book: Book = {
  id: 'bk',
  revision: 1,
  title: 'Transformer',
  description: '',
  status: 'compiling',
  proposal: null,
  knowledge_bases: [],
  language: 'en',
  page_count: 2,
  chapter_count: 2,
  created_at: 1,
  updated_at: 1,
  metadata: {},
}
const page: Page = {
  id: 'pg',
  book_id: 'bk',
  chapter_id: 'ch',
  title: 'Attention',
  learning_objectives: [],
  content_type: 'theory',
  status: 'ready',
  order: 0,
  blocks: [],
  links: [],
  parent_page_id: '',
  error: '',
  created_at: 1,
  updated_at: 1,
}

beforeEach(() => {
  fixture.createClient.mockClear()
})

it('prefills and focuses a widget question once without sending, including in StrictMode', () => {
  const consumed = vi.fn()
  render(
    <StrictMode>
      <BookChatPanel
        book={book}
        page={page}
        open
        onClose={vi.fn()}
        prefillPrompt={{ id: 'prompt-1', text: 'Why is attention parallel?' }}
        onPrefillConsumed={consumed}
      />
    </StrictMode>
  )

  const input = screen.getByRole('textbox')
  expect(input).toHaveValue('Why is attention parallel?')
  expect(input).toHaveFocus()
  expect(consumed).toHaveBeenCalledExactlyOnceWith('prompt-1')
  expect(fixture.createClient).not.toHaveBeenCalled()
})

it('preserves an existing draft when another widget question is selected', () => {
  const props = { book, page, open: true, onClose: vi.fn() }
  const { rerender } = render(<BookChatPanel {...props} />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Compare this with RNNs.' } })

  rerender(
    <BookChatPanel
      {...props}
      prefillPrompt={{ id: 'prompt-2', text: 'Explain sequence complexity.' }}
    />
  )

  expect(input).toHaveValue('Compare this with RNNs.\n\nExplain sequence complexity.')
  expect(fixture.createClient).not.toHaveBeenCalled()
})
