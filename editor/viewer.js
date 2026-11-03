// A scrolling PDF viewer on pdf.js: lazy page rendering, zoom, internal links, and a reading
// position that survives replacing the document with a rebuilt one.
import * as pdfjs from './vendor/pdfjs/pdf.min.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href
const CMAP_URL = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href
const FONT_URL = new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const PAGE_GAP = 10

/**
 * @param {{ scroller: HTMLElement, pageInput?: HTMLInputElement, pageCount?: HTMLElement, zoomLabel?: HTMLElement, onChange?: () => void,
 *   onDoubleClick?: (point: { page: number, x: number, y: number }) => void }} els
 */
export function createViewer(els) {
  const view = { pdf: null, pages: [], zoom: 'fit', observer: null, generation: 0 }

  function readAnchor() {
    const top = els.scroller.scrollTop
    for (let i = 0; i < view.pages.length; i += 1) {
      const page = view.pages[i]
      const start = page.el.offsetTop - PAGE_GAP / 2
      const end = page.el.offsetTop + page.el.offsetHeight + PAGE_GAP / 2
      if (top < end) return { index: i, fraction: Math.max(0, (top - start) / (end - start)), left: els.scroller.scrollLeft }
    }
    return { index: 0, fraction: 0, left: 0 }
  }

  function restoreAnchor(anchor) {
    const page = view.pages[Math.min(anchor.index, view.pages.length - 1)]
    if (!page) return
    els.scroller.scrollTop = page.el.offsetTop - PAGE_GAP / 2 + anchor.fraction * (page.el.offsetHeight + PAGE_GAP)
    els.scroller.scrollLeft = anchor.left
  }

  function scaleFor(viewport1) {
    if (view.zoom !== 'fit') return view.zoom
    return Math.max(120, els.scroller.clientWidth - 24) / viewport1.width
  }

  async function renderPage(page, generation) {
    if (page.rendered === page.scale || generation !== view.generation) return
    page.task?.cancel()
    const ratio = window.devicePixelRatio || 1
    const viewport = page.pdfPage.getViewport({ scale: page.scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    const task = page.pdfPage.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined
    })
    page.task = task
    try {
      await task.promise
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') console.warn(`page render failed: ${error.message}`)
      return
    }
    page.task = null
    page.rendered = page.scale
    page.canvas?.remove()
    page.canvas = canvas
    page.el.prepend(canvas)
    void addLinks(page)
  }

  async function addLinks(page) {
    page.el.querySelectorAll('a.link').forEach((link) => link.remove())
    let annotations = []
    try {
      annotations = await page.pdfPage.getAnnotations({ intent: 'display' })
    } catch {
      return
    }
    const viewport = page.pdfPage.getViewport({ scale: page.scale })
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link' || (!annotation.dest && !annotation.url)) continue
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect)
      const link = document.createElement('a')
      link.className = 'link'
      Object.assign(link.style, {
        left: `${Math.min(x1, x2)}px`,
        top: `${Math.min(y1, y2)}px`,
        width: `${Math.abs(x2 - x1)}px`,
        height: `${Math.abs(y2 - y1)}px`
      })
      link.href = '#'
      link.title = annotation.url ?? 'Go to'
      link.addEventListener('click', (event) => {
        event.preventDefault()
        if (annotation.url) void orca.shell?.openExternal(annotation.url)
        else void goToDestination(annotation.dest)
      })
      page.el.append(link)
    }
  }

  async function goToDestination(dest) {
    const doc = view.pdf
    if (!doc) return
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit)) return
    const index = typeof explicit[0] === 'number' ? explicit[0] : await doc.getPageIndex(explicit[0])
    const page = view.pages[index]
    if (!page) return
    let offset = 0
    if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') {
      const viewport = page.pdfPage.getViewport({ scale: page.scale })
      offset = Math.max(0, viewport.convertToViewportPoint(0, explicit[3])[1] - 20)
    }
    els.scroller.scrollTop = page.el.offsetTop + offset
  }

  function observePages(generation) {
    view.observer?.disconnect()
    view.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const page = view.pages[Number(entry.target.dataset.index)]
          if (page) void renderPage(page, generation)
        }
      },
      { root: els.scroller, rootMargin: '600px 0px' }
    )
    for (const page of view.pages) view.observer.observe(page.el)
  }

  function currentScale() {
    return view.pages[0]?.scale ?? 1
  }

  function updateLabels() {
    if (els.zoomLabel) {
      els.zoomLabel.textContent = view.zoom === 'fit' ? 'Fit' : `${Math.round(currentScale() * 100)}%`
      els.zoomLabel.title = `Fit to width (now ${Math.round(currentScale() * 100)}%)`
    }
    if (els.pageInput && view.pages.length) {
      els.pageInput.parentElement.hidden = false
      els.pageCount.textContent = `/ ${view.pages.length}`
      els.pageInput.style.width = `${String(view.pages.length).length + 1.2}ch`
      // Leave what the reader is typing alone.
      if (document.activeElement !== els.pageInput) els.pageInput.value = String(readAnchor().index + 1)
    }
  }

  function rescale() {
    if (!view.pages.length) return updateLabels()
    const anchor = readAnchor()
    const scale = scaleFor(view.pages[0].pdfPage.getViewport({ scale: 1 }))
    for (const page of view.pages) {
      const viewport = page.pdfPage.getViewport({ scale })
      page.scale = scale
      page.el.style.width = `${Math.floor(viewport.width)}px`
      page.el.style.height = `${Math.floor(viewport.height)}px`
    }
    restoreAnchor(anchor)
    observePages(view.generation)
    updateLabels()
  }

  function setZoom(zoom) {
    view.zoom = zoom
    rescale()
  }

  function stepZoom(direction) {
    const scale = currentScale()
    setZoom(
      direction > 0
        ? (ZOOM_STEPS.find((step) => step > scale + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((step) => step < scale - 0.01) ?? ZOOM_STEPS[0])
    )
  }

  /** Replaces the document, keeping the reader's place. Resolves once it is on screen. */
  async function show(bytes) {
    const generation = ++view.generation
    const anchor = view.pages.length ? readAnchor() : { index: 0, fraction: 0, left: 0 }
    const doc = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      isEvalSupported: false,
      enableXfa: false
    }).promise
    const pdfPages = []
    for (let n = 1; n <= doc.numPages; n += 1) pdfPages.push(await doc.getPage(n))
    if (generation !== view.generation) {
      void doc.destroy()
      return
    }
    const scale = scaleFor(pdfPages[0].getViewport({ scale: 1 }))
    const container = document.createElement('div')
    container.className = 'pages'
    const pages = pdfPages.map((pdfPage, i) => {
      const viewport = pdfPage.getViewport({ scale })
      const el = document.createElement('div')
      el.className = 'page'
      el.dataset.index = String(i)
      el.style.width = `${Math.floor(viewport.width)}px`
      el.style.height = `${Math.floor(viewport.height)}px`
      container.append(el)
      return { el, pdfPage, canvas: null, scale, rendered: 0, task: null }
    })
    // Paint what the reader is looking at before swapping, so a rebuild does not flash.
    const first = Math.min(anchor.index, pages.length - 1)
    await Promise.all(pages.slice(first, first + 2).map((page) => renderPage(page, generation)))
    if (generation !== view.generation) {
      void doc.destroy()
      return
    }
    view.observer?.disconnect()
    for (const page of view.pages) page.task?.cancel()
    const previous = view.pdf
    els.scroller.querySelector('.pages')?.remove()
    els.scroller.append(container)
    view.pdf = doc
    view.pages = pages
    restoreAnchor(anchor)
    observePages(generation)
    updateLabels()
    if (previous) void previous.destroy()
    els.onChange?.()
  }

  /** Scrolls to the top of 1-based `pageNumber`, clamped to the document. */
  function goToPage(pageNumber) {
    if (!view.pages.length) return
    const page = view.pages[Math.min(Math.max(1, Math.round(pageNumber)), view.pages.length) - 1]
    els.scroller.scrollTop = page.el.offsetTop - PAGE_GAP
    updateLabels()
  }

  /** Scrolls so `boxes` (PDF points from the top-left of 1-based `pageNumber`) show, and marks them. */
  function reveal(pageNumber, boxes) {
    const page = view.pages[pageNumber - 1]
    if (!page) return
    page.el.querySelectorAll('.sync-mark').forEach((mark) => mark.remove())
    const marks = boxes.map((box) => {
      const mark = document.createElement('div')
      mark.className = 'sync-mark'
      Object.assign(mark.style, {
        left: `${box.x * page.scale - 2}px`,
        top: `${box.y * page.scale - 2}px`,
        width: `${box.w * page.scale + 4}px`,
        height: `${box.h * page.scale + 4}px`
      })
      page.el.append(mark)
      return mark
    })
    const top = Math.min(...boxes.map((box) => box.y)) * page.scale
    const target = page.el.offsetTop + top - els.scroller.clientHeight / 3
    els.scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    const left = Math.min(...boxes.map((box) => box.x)) * page.scale
    if (left < els.scroller.scrollLeft || left > els.scroller.scrollLeft + els.scroller.clientWidth - 40) {
      els.scroller.scrollLeft = Math.max(0, left - 40)
    }
    setTimeout(() => marks.forEach((mark) => mark.classList.add('fade')), 1200)
    setTimeout(() => marks.forEach((mark) => mark.remove()), 2600)
  }

  if (els.pageInput) {
    const input = els.pageInput
    // Digits only, whatever is typed or pasted.
    input.addEventListener('beforeinput', (event) => {
      if (event.data && /\D/.test(event.data)) event.preventDefault()
    })
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '')
      if (digits !== input.value) input.value = digits
    })
    const commit = () => {
      const value = Number(input.value)
      if (input.value && value >= 1) goToPage(value)
      input.value = String(readAnchor().index + 1)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
        input.blur()
      } else if (event.key === 'Escape') {
        input.value = String(readAnchor().index + 1)
        input.blur()
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        goToPage(readAnchor().index + 1 + (event.key === 'ArrowUp' ? -1 : 1))
        input.value = String(readAnchor().index + 1)
      }
    })
    input.addEventListener('focus', () => input.select())
    input.addEventListener('blur', commit)
  }

  els.scroller.addEventListener('dblclick', (event) => {
    const pageEl = event.target.closest?.('.page')
    if (!pageEl || !els.onDoubleClick) return
    const page = view.pages[Number(pageEl.dataset.index)]
    const rect = pageEl.getBoundingClientRect()
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    els.onDoubleClick({
      page: Number(pageEl.dataset.index) + 1,
      x: (event.clientX - rect.left) / page.scale,
      y: (event.clientY - rect.top) / page.scale
    })
  })

  els.scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      stepZoom(event.deltaY < 0 ? 1 : -1)
    },
    { passive: false }
  )
  els.scroller.addEventListener('scroll', () => requestAnimationFrame(updateLabels), { passive: true })
  let resizeTimer = 0
  new ResizeObserver(() => {
    if (view.zoom !== 'fit') return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(rescale, 120)
  }).observe(els.scroller)

  return {
    show,
    reveal,
    goToPage,
    get pageCount() {
      return view.pages.length
    },
    setZoom,
    stepZoom,
    get hasDocument() {
      return view.pdf !== null
    }
  }
}
