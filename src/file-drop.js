/**
 * Drag-and-drop + hidden file picker for the source track.
 *
 * Adapted from wave-gpu's `src/ui/file-drop.ts`: listen on the document so a
 * drop anywhere works, track drag depth so leave events on child elements do
 * not flicker the state, and reset the input value so picking the same file
 * twice fires `change` again.
 */

export function createFileDrop(doc, { onFile, onError, stage }) {
  const input = doc.querySelector('#audioFile')
  let dragDepth = 0

  const hasFiles = (event) => {
    const types = event.dataTransfer?.types
    return types !== undefined && Array.from(types).includes('Files')
  }

  const setDragging = (on) => stage?.classList.toggle('is-dragover', on)

  function openPicker() {
    if (!input) return
    input.value = ''
    input.click()
  }

  input?.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) onFile(file)
    input.value = ''
  })

  doc.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth += 1
    setDragging(true)
  })

  doc.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  })

  doc.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragging(false)
  })

  doc.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return
    // Never let the browser navigate away to the dropped file.
    event.preventDefault()
    dragDepth = 0
    setDragging(false)
    const file = event.dataTransfer?.files?.[0]
    if (!file) {
      onError('that drop did not contain a file')
      return
    }
    onFile(file)
  })

  return { openPicker }
}
