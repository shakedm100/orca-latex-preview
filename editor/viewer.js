// A scrolling PDF viewer on pdf.js: lazy page rendering, zoom, internal links, and a reading
// position that survives replacing the document with a rebuilt one.
import * as pdfjs from './vendor/pdfjs/pdf.min.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const PAGE_GAP = 10

/**
 * @param {{ scroller: HTMLElement, pageInput?: HTMLInputElement, pageCount?: HTMLElement, zoomLabel?: HTMLElement, onChange?: () => void,
 *   onDoubleClick?: (point: { page: number, x: number, y: number }) => void }} els
 */
export function createViewer(els) {
  const view = { pdf: null, pages: [], zoom: 'fit', observer: null, generation: 0, place: null }
  // Find in PDF: the query, every hit as boxes in PDF points from the page's top-left, the
  // current one, and each page's searchable text (built once per document).
  const find = { query: '', hits: [], index: -1, texts: null, generation: 0 }

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
    void addTextLayer(page, viewport, generation)
    void addLinks(page)
  }

  /** Invisible text over the canvas, so text can be selected with the mouse and copied. */
  async function addTextLayer(page, viewport, generation) {
    const layer = document.createElement('div')
    layer.className = 'textLayer'
    const textLayer = new pdfjs.TextLayer({ textContentSource: page.pdfPage.streamTextContent(), container: layer, viewport })
    try {
      await textLayer.render()
    } catch {
      return
    }
    if (generation !== view.generation || page.rendered !== viewport.scale) return
    // pdf.js's viewer adds this: it keeps a drag that leaves the text from selecting the whole page.
    const end = document.createElement('div')
    end.className = 'endOfContent'
    layer.append(end)
    page.textLayer?.remove()
    page.textLayer = layer
    page.canvas.after(layer)
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
      page.el.style.setProperty('--scale-factor', String(scale))
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
    const anchor = view.pages.length ? readAnchor() : (view.place ?? { index: 0, fraction: 0, left: 0 })
    const doc = await pdfjs.getDocument({
      // No character maps or standard font files: the store refuses binary files, and TeX
      // engines embed every font, so pdf.js falls back to system fonts only for other PDFs.
      data: bytes,
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
      el.style.setProperty('--scale-factor', String(scale))
      container.append(el)
      return { el, pdfPage, canvas: null, textLayer: null, scale, rendered: 0, task: null }
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
    view.place = null
    observePages(generation)
    updateLabels()
    if (previous) void previous.destroy()
    find.texts = null
    if (find.query) void runFind(find.query, { keepPlace: true })
    els.onChange?.()
  }

  // ------------------------------------------------------------------ find in PDF

  /** Each page's text with whitespace collapsed, and where each character came from. */
  async function pageTexts() {
    if (find.texts) return find.texts
    const texts = []
    for (const page of view.pages) {
      let items = []
      try {
        items = (await page.pdfPage.getTextContent()).items
      } catch {
        // A page whose text cannot be read is not searchable.
      }
      let text = ''
      const from = [] // per character: [item index, offset in item]
      const add = (char, where) => {
        if (/\s/.test(char)) {
          if (text.endsWith(' ') || text === '') return
          char = ' '
        }
        text += char
        from.push(where)
      }
      items.forEach((item, i) => {
        if (typeof item.str !== 'string') return
        for (let k = 0; k < item.str.length; k += 1) add(item.str[k], [i, k])
        if (item.hasEOL) add(' ', null)
      })
      texts.push({ text: text.toLowerCase(), from, items, viewport: page.pdfPage.getViewport({ scale: 1 }) })
    }
    find.texts = texts
    return texts
  }

  /** Boxes, in PDF points from the page's top-left, around characters [start, end) of a page's text. */
  function boxesFor(entry, start, end) {
    const runs = new Map() // item index -> [first offset, last offset]
    for (let c = start; c < end; c += 1) {
      const where = entry.from[c]
      if (!where) continue
      const run = runs.get(where[0])
      if (run) run[1] = where[1]
      else runs.set(where[0], [where[1], where[1]])
    }
    const boxes = []
    for (const [i, [first, last]] of runs) {
      const item = entry.items[i]
      const [, , c, d, e, f] = item.transform
      const size = Math.hypot(c, d) || item.height || 10
      const perChar = item.str.length ? item.width / item.str.length : 0
      const x = e + perChar * first
      const [x1, y1, x2, y2] = entry.viewport.convertToViewportRectangle([x, f - size * 0.25, x + perChar * (last - first + 1), f + size * 0.85])
      boxes.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })
    }
    return boxes
  }

  const MAX_HITS = 5000

  async function runFind(query, { keepPlace = false } = {}) {
    const generation = ++find.generation
    const previous = keepPlace ? find.hits[find.index] : null
    find.query = query
    find.hits = []
    find.index = -1
    clearHitMarks()
    const needle = query.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!needle || !view.pages.length) return report()
    const texts = await pageTexts()
    if (generation !== find.generation) return
    texts.forEach((entry, pageIndex) => {
      let at = entry.text.indexOf(needle)
      while (at !== -1 && find.hits.length < MAX_HITS) {
        find.hits.push({ page: pageIndex, boxes: boxesFor(entry, at, at + needle.length) })
        at = entry.text.indexOf(needle, at + needle.length)
      }
    })
    if (find.hits.length) {
      // Start from the reader's place: the same hit after a rebuild, else the first one on screen.
      const anchor = readAnchor()
      const wanted = previous ? previous.page : anchor.index
      const index = find.hits.findIndex((hit) => hit.page >= wanted)
      find.index = index === -1 ? 0 : index
    }
    drawHitMarks()
    if (!keepPlace) scrollToHit()
    return report()
  }

  function report() {
    const result = { query: find.query, count: find.hits.length, index: find.index, capped: find.hits.length >= MAX_HITS }
    els.onFind?.(result)
    return result
  }

  function clearHitMarks() {
    els.scroller.querySelectorAll('.find-hit').forEach((mark) => mark.remove())
  }

  function drawHitMarks() {
    clearHitMarks()
    find.hits.forEach((hit, i) => {
      const page = view.pages[hit.page]
      if (!page) return
      for (const box of hit.boxes) {
        const mark = document.createElement('div')
        mark.className = i === find.index ? 'find-hit current' : 'find-hit'
        // In PDF points times the page's --scale-factor, so zooming keeps them in place.
        Object.assign(mark.style, {
          left: `calc(var(--scale-factor) * ${box.x.toFixed(2)}px)`,
          top: `calc(var(--scale-factor) * ${box.y.toFixed(2)}px)`,
          width: `calc(var(--scale-factor) * ${box.w.toFixed(2)}px)`,
          height: `calc(var(--scale-factor) * ${box.h.toFixed(2)}px)`
        })
        page.el.append(mark)
      }
    })
  }

  function scrollToHit() {
    const hit = find.hits[find.index]
    const page = hit && view.pages[hit.page]
    if (!page || !hit.boxes.length) return
    const top = Math.min(...hit.boxes.map((box) => box.y)) * page.scale
    const left = Math.min(...hit.boxes.map((box) => box.x)) * page.scale
    els.scroller.scrollTop = Math.max(0, page.el.offsetTop + top - els.scroller.clientHeight / 3)
    if (left < els.scroller.scrollLeft || left > els.scroller.scrollLeft + els.scroller.clientWidth - 40) {
      els.scroller.scrollLeft = Math.max(0, left - 40)
    }
    updateLabels()
  }

  function stepFind(direction) {
    if (!find.hits.length) return report()
    find.index = (find.index + direction + find.hits.length) % find.hits.length
    drawHitMarks()
    scrollToHit()
    return report()
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

  // A drag that starts on text selects text; pdf.js's viewer marks the layer while it does.
  els.scroller.addEventListener('pointerdown', (event) => {
    const layer = event.target.closest?.('.textLayer')
    if (layer && event.button === 0) layer.classList.add('selecting')
  })
  document.addEventListener('pointerup', () => {
    els.scroller.querySelectorAll('.textLayer.selecting').forEach((layer) => layer.classList.remove('selecting'))
  })

  return {
    show,
    reveal,
    find: (query) => runFind(query),
    findNext: () => stepFind(1),
    findPrevious: () => stepFind(-1),
    clearFind: () => runFind(''),
    get findQuery() {
      return find.query
    },
    /** Where the reader is (page, position on it, zoom), to restore when the view reopens. */
    getPlace: () => (view.pages.length ? { ...readAnchor(), zoom: view.zoom } : null),
    /** Opens the next document at `place` instead of the top. */
    setPlace(place) {
      if (!place || !Number.isInteger(place.index)) return
      if (place.zoom === 'fit' || (typeof place.zoom === 'number' && place.zoom > 0)) view.zoom = place.zoom
      const anchor = { index: place.index, fraction: Number(place.fraction) || 0, left: Number(place.left) || 0 }
      if (view.pages.length) {
        rescale()
        restoreAnchor(anchor)
        updateLabels()
      } else view.place = anchor
    },
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
