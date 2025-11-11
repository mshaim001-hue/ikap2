const DEFAULT_TIMEOUT = 60000

const withTimeout = (promise, timeoutMs = DEFAULT_TIMEOUT) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id)
        reject(new Error('Request timed out'))
      }, timeoutMs)
    }),
  ])

const normalizePath = (path) => {
  if (!path) return ''
  if (path.startsWith('http')) {
    return path
  }
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
  const target = path.startsWith('/') ? path : `/${path}`
  return `${base}${target}`
}

export const apiFetch = async (path, options = {}) => {
  const { timeout, headers, ...rest } = options
  const requestInit = {
    credentials: 'include',
    cache: 'no-store',
    ...rest,
  }

  if (headers) {
    requestInit.headers = headers
  } else {
    requestInit.headers = {}
  }

  if (!requestInit.headers['Cache-Control']) {
    requestInit.headers['Cache-Control'] = 'no-cache'
    requestInit.headers['Pragma'] = 'no-cache'
  }

  const response = await withTimeout(fetch(normalizePath(path), requestInit), timeout)

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`
    try {
      const errorBody = await response.json()
      errorMessage = errorBody?.error || errorBody?.message || errorMessage
      const error = new Error(errorMessage)
      error.status = response.status
      error.details = errorBody
      throw error
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message === 'Request timed out') {
        throw parseError
      }
      const error = new Error(errorMessage)
      error.status = response.status
      throw error
    }
  }

  const text = await response.text()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export default apiFetch

