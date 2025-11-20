import { apiFetch } from './client'

const ANALYSIS_ENDPOINT = import.meta.env.VITE_ANALYSIS_ENDPOINT || '/api/analysis'
const REPORTS_ENDPOINT = import.meta.env.VITE_REPORTS_ENDPOINT || '/api/reports'

export const analyzeStatements = async ({ comment, files, metadata }) => {
  const formData = new FormData()

  if (comment) {
    formData.append('comment', comment)
  }

  if (metadata && typeof metadata === 'object') {
    formData.append('metadata', JSON.stringify(metadata))
  }

  ;(files || []).forEach((file) => {
    formData.append('files', file)
  })

  return apiFetch(ANALYSIS_ENDPOINT, {
    method: 'POST',
    body: formData,
  })
}

export const fetchReportsList = async () => {
  const data = await apiFetch(REPORTS_ENDPOINT, {
    method: 'GET',
  })

  if (Array.isArray(data)) return data
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.items)) return data.items
  return []
}

export const fetchReportBySession = async (sessionId) => {
  if (!sessionId) {
    return null
  }

  const data = await apiFetch(`${REPORTS_ENDPOINT}/${sessionId}`, {
    method: 'GET',
  })

  if (data && typeof data === 'object' && data.data && !Array.isArray(data.data)) {
    return data.data
  }

  return data
}

export const fetchMessagesBySession = async (sessionId) => {
  if (!sessionId) {
    return []
  }

  const data = await apiFetch(`${REPORTS_ENDPOINT}/${sessionId}/messages`, {
    method: 'GET',
  })

  if (Array.isArray(data)) return data
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.messages)) return data.messages
  return []
}

export const deleteReport = async (sessionId) => {
  if (!sessionId) {
    throw new Error('Не указан идентификатор отчёта.')
  }

  await apiFetch(`${REPORTS_ENDPOINT}/${sessionId}`, {
    method: 'DELETE',
  })

  return true
}

export const wakeUpServer = async () => {
  // Отправляем запрос на /ping для "пробуждения" сервера
  // (если сервер "спит" на Render.com или другом хостинге)
  try {
    await apiFetch('/ping', {
      method: 'GET',
      timeout: 15000, // 15 секунд таймаут для холодного старта
    })
    return true
  } catch (error) {
    // Даже если запрос упал, сервер может начать просыпаться
    console.warn('⚠️ Ошибка пробуждения сервера:', error)
    return false
  }
}

