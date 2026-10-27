// @vitest-environment jsdom
/**
 * The lightbox is a full-window Dialog on its module store: it opens from
 * the store, the arrows step it, the counter follows, and every close goes
 * back through the store.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => new Map<string, { resolve: (url: string) => void; reject: (e: Error) => void }>())
vi.mock('../lib/tcserver/commands', () => ({
  readAttachment: (_env: string, path: string) =>
    new Promise<string>((resolve, reject) => reads.set(path, { resolve, reject })),
}))

import { Lightbox } from './Lightbox'
import { closeLightbox, isLightboxOpen, openLightbox } from './lightboxStore'

const items = [
  { environmentId: 'local', name: 'one.png', src: 'data:image/png;base64,AA==' },
  { environmentId: 'local', name: 'two.png', src: 'data:image/png;base64,AB==' },
  { environmentId: 'local', name: 'three.png', src: 'data:image/png;base64,AC==' },
]

afterEach(() => {
  act(() => closeLightbox())
  cleanup()
})

describe('Lightbox', () => {
  it('renders nothing until the store opens, then fills the window', () => {
    render(<Lightbox />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openLightbox(items, 1))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('data-size')).toBe('full')
    expect(dialog.hasAttribute('data-lightbox')).toBe(true)
    expect(screen.getByRole('img', { name: 'two.png' })).toBeTruthy()
    expect(dialog.textContent).toContain('2 / 3')
  })

  it('the arrows step through the group and the counter follows, wrapping', () => {
    render(<Lightbox />)
    act(() => openLightbox(items, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByRole('img', { name: 'two.png' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('2 / 3')
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(screen.getByRole('img', { name: 'three.png' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('3 / 3')
  })

  it('one image has no arrows and no counter', () => {
    render(<Lightbox />)
    act(() => openLightbox(items.slice(0, 1)))
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
    expect(screen.getByRole('dialog').textContent).not.toContain('/')
  })

  it('the close button, Escape and a click beside the image close the store', async () => {
    render(<Lightbox />)
    act(() => openLightbox(items, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(isLightboxOpen()).toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    act(() => openLightbox(items, 0))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(isLightboxOpen()).toBe(false)

    act(() => openLightbox(items, 0))
    fireEvent.click(screen.getByRole('dialog'))
    expect(isLightboxOpen()).toBe(false)
  })

  it('Escape closes it and focus goes back to the button that opened it', async () => {
    render(
      <>
        <button type="button" onClick={() => openLightbox(items, 0)}>
          Preview one.png
        </button>
        <Lightbox />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Preview one.png' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(isLightboxOpen()).toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('a second mounted host renders nothing: one overlay for split panes', () => {
    render(
      <>
        <Lightbox />
        <Lightbox />
      </>,
    )
    act(() => openLightbox(items, 0))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })
})

describe('Lightbox loading and failure', () => {
  it('says Loading… while the image is read, then shows it', async () => {
    render(<Lightbox />)
    act(() => openLightbox([{ environmentId: 'local', name: 'shot.png', path: '/att/shot.png' }]))
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => reads.get('/att/shot.png')!.resolve('data:image/png;base64,AA=='))
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('says it could not open the image when the read fails or the image will not load, instead of spinning', async () => {
    render(<Lightbox />)
    act(() => openLightbox([{ environmentId: 'local', name: 'gone.png', path: '/att/gone.png' }]))
    await act(async () => reads.get('/att/gone.png')!.reject(new Error('ENOENT')))
    await waitFor(() => expect(screen.getByText('Couldn’t open gone.png')).toBeTruthy())
    expect(screen.queryByText('Loading…')).toBeNull()

    act(() => closeLightbox())
    act(() => openLightbox([{ environmentId: 'local', name: 'broken.png', src: 'data:image/png;base64,AA==' }]))
    fireEvent.error(screen.getByRole('img', { name: 'broken.png' }))
    expect(screen.getByText('Couldn’t open broken.png')).toBeTruthy()
  })
})
