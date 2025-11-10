import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Inbox,
  X,
} from 'lucide-react'
import './App.css'
import {
  analyzeStatements,
  fetchMessagesBySession,
  fetchReportBySession,
  fetchReportsList,
} from './api/analysis'

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

const statusLabels = {
  generating: 'В обработке',
  pending: 'В очереди',
  completed: 'Готово',
  failed: 'Ошибка',
}

const statusIcons = {
  generating: Clock,
  pending: Clock,
  completed: CheckCircle2,
  failed: AlertCircle,
}

const formatDate = (value) => {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const formatFileSize = (size) => {
  if (typeof size !== 'number' || Number.isNaN(size)) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const extractMessageText = (message) => {
  if (!message) return ''

  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message.map(extractMessageText).filter(Boolean).join('\n')
  }

  if (typeof message === 'object') {
    if (typeof message.text === 'string') return message.text
    if (Array.isArray(message.text)) {
      return message.text.map((item) => (typeof item === 'string' ? item : extractMessageText(item))).join('\n')
    }
    if (message.content) {
      return extractMessageText(message.content)
    }
  }

  try {
    return JSON.stringify(message, null, 2)
  } catch {
    return String(message)
  }
}

const StatusBadge = ({ status }) => {
  const normalized = status?.toLowerCase()
  const Icon = statusIcons[normalized] || Clock
  return (
    <span className={`status-badge status-${normalized || 'pending'}`}>
      <Icon size={14} />
      {statusLabels[normalized] || status || 'Неизвестно'}
    </span>
  )
}

const EmptyState = ({ title, description, icon, action }) => {
  const IconComponent = icon || Inbox
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <IconComponent size={28} />
      </div>
      <div className="empty-state-content">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
        {action}
      </div>
    </div>
  )
}

const UploadPanel = ({
  files,
  onFilesChange,
  onRemoveFile,
  comment,
  onCommentChange,
  onSubmit,
  isSubmitting,
  error,
}) => {
  const canSubmit = files.length > 0

  return (
    <section className="card upload-card">
      <header className="card-header">
        <div>
          <h2>Новый анализ</h2>
          <p>Загрузите банковские выписки и сопроводительный комментарий для запуска анализа</p>
        </div>
      </header>
      <div className="card-body">
        {error && (
          <div className="form-alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <label className="file-input-label">
          <input
            type="file"
            multiple
            accept=".pdf,application/pdf,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              const selected = Array.from(event.target.files || [])
              onFilesChange(selected)
              event.target.value = ''
            }}
          />
          <Paperclip size={18} />
          <span>Прикрепить файлы</span>
          <small>PDF или XLSX, до 50 МБ каждый</small>
        </label>

        {files.length > 0 && (
          <ul className="selected-files">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <div className="file-info">
                  <FileText size={16} />
                  <div className="file-meta">
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{formatFileSize(file.size)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onRemoveFile(index)}
                  aria-label="Удалить файл"
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="form-field">
          <label htmlFor="comment">Комментарий для аналитика</label>
          <textarea
            id="comment"
            placeholder="Укажите важные детали: приоритетные банки, периоды, контекст..."
            value={comment}
            onChange={(event) => onCommentChange(event.target.value)}
            rows={4}
          />
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={onSubmit}
          disabled={!canSubmit || isSubmitting}
        >
          {isSubmitting ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
          {isSubmitting ? 'Отправляем...' : 'Отправить на анализ'}
        </button>
      </div>
    </section>
  )
}

const MessagesPanel = ({ messages, isLoading, status, updatedAt }) => (
  <section className="card messages-card">
    <header className="card-header">
      <div>
        <h2>Ответы агента</h2>
        <p>История взаимодействия по текущей сессии</p>
      </div>
      {status && (
        <div className="status-wrapper">
          <StatusBadge status={status} />
          <span className="updated-at">Обновлено: {formatDate(updatedAt)}</span>
        </div>
      )}
    </header>
    <div className="card-body messages-body">
      {isLoading ? (
        <div className="loading-state">
          <Loader2 size={20} className="spin" />
          <span>Загружаем историю сообщений...</span>
        </div>
      ) : messages.length === 0 ? (
        <EmptyState
          title="Нет сообщений"
          description="Сообщения появятся после запуска анализа и ответа агента."
        />
      ) : (
        <ul className="messages-timeline">
          {messages.map((message, index) => {
            const role = message.role || message.author || 'agent'
            const text = extractMessageText(message.content || message.text || message)
            return (
              <li key={`${role}-${index}`} className={`timeline-item timeline-${role}`}>
                <div className="timeline-marker" />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <span className="timeline-role">
                      {role === 'user' ? 'Сотрудник' : 'Аналитический агент'}
                    </span>
                    {message.created_at && (
                      <span className="timeline-date">{formatDate(message.created_at)}</span>
                    )}
                  </div>
                  <p>{text}</p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  </section>
)

const ReportsList = ({
  reports,
  isLoading,
  onRefresh,
  onSelect,
  activeSessionId,
  searchTerm,
  onSearchChange,
}) => (
  <section className="card reports-card">
    <header className="card-header">
      <div>
        <h2>История анализов</h2>
        <p>Последние заявки и статусы обработки</p>
      </div>
      <button type="button" className="icon-button" onClick={onRefresh} aria-label="Обновить список">
        <RefreshCw size={18} />
      </button>
    </header>
    <div className="card-body reports-body">
      <div className="search-field">
        <Search size={16} />
        <input
          type="search"
          placeholder="Поиск по БИН, компании или комментарию"
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="loading-state">
          <Loader2 size={20} className="spin" />
          <span>Загружаем отчёты...</span>
        </div>
      ) : reports.length === 0 ? (
        <EmptyState
          title="Отчётов пока нет"
          description="Создайте первую заявку, чтобы увидеть результаты анализа."
        />
      ) : (
        <ul className="reports-list">
          {reports.map((report) => {
            const sessionKey = report.session_id || report.id
            return (
            <li
              key={sessionKey}
              className={`reports-item ${
                activeSessionId && activeSessionId === sessionKey ? 'reports-item-active' : ''
              }`}
            >
              <button type="button" onClick={() => onSelect(sessionKey)}>
                <div className="reports-item-header">
                  <strong>{report.company_bin || 'Не указан БИН'}</strong>
                  <StatusBadge status={report.status} />
                </div>
                <div className="reports-item-meta">
                  <span>{report.name || report.email || '—'}</span>
                  <span>{formatDate(report.created_at)}</span>
                </div>
                {report.comment && <p className="reports-item-comment">{report.comment}</p>}
              </button>
            </li>
            )
          })}
        </ul>
      )}
    </div>
  </section>
)

const ReportDetails = ({ report, isLoading }) => (
  <section className="card details-card">
    <header className="card-header">
      <div>
        <h2>Детали отчёта</h2>
        <p>Описание результата анализа и ключевые показатели</p>
      </div>
    </header>
    <div className="card-body details-body">
      {isLoading ? (
        <div className="loading-state">
          <Loader2 size={20} className="spin" />
          <span>Загружаем отчёт...</span>
        </div>
      ) : !report ? (
        <EmptyState
          title="Выберите отчёт"
          description="Нажмите на заявку из списка, чтобы увидеть подробности анализа."
        />
      ) : (
        <>
          <div className="details-grid">
            <div className="details-item">
              <span className="details-label">Статус</span>
              <StatusBadge status={report.status} />
            </div>
            <div className="details-item">
              <span className="details-label">Создано</span>
              <span>{formatDate(report.created_at)}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Завершено</span>
              <span>{formatDate(report.completed_at)}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Количество файлов</span>
              <span>{report.files_count ?? '—'}</span>
            </div>
          </div>

          <div className="details-grid">
            <div className="details-item">
              <span className="details-label">Компания (БИН)</span>
              <span>{report.company_bin || '—'}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Запрашиваемая сумма</span>
              <span>{report.amount || '—'}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Срок</span>
              <span>{report.term || '—'}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Цель финансирования</span>
              <span>{report.purpose || '—'}</span>
            </div>
          </div>

          <div className="details-grid">
            <div className="details-item">
              <span className="details-label">Контактное лицо</span>
              <span>{report.name || '—'}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Телефон</span>
              <span>{report.phone || '—'}</span>
            </div>
            <div className="details-item">
              <span className="details-label">Email</span>
              <span>{report.email || '—'}</span>
            </div>
          </div>

          {report.report_text && (
            <div className="details-report">
              <h3>Основной отчёт</h3>
              <article>
                {report.report_text.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </article>
            </div>
          )}

          {(report.tax_report_text || report.fs_report_text) && (
            <div className="details-columns">
              {report.tax_report_text && (
                <div className="details-report">
                  <h3>Налоговый анализ</h3>
                  <article>
                    {report.tax_report_text.split('\n').map((line, index) => (
                      <p key={`tax-${index}`}>{line}</p>
                    ))}
                  </article>
                </div>
              )}
              {report.fs_report_text && (
                <div className="details-report">
                  <h3>Финансовая отчётность</h3>
                  <article>
                    {report.fs_report_text.split('\n').map((line, index) => (
                      <p key={`fs-${index}`}>{line}</p>
                    ))}
                  </article>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  </section>
)

function App() {
  const queryClient = useQueryClient()
  const [files, setFiles] = useState([])
  const [comment, setComment] = useState('')
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [submitError, setSubmitError] = useState('')
  const [shouldPoll, setShouldPoll] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  const reportsQuery = useQuery({
    queryKey: ['reports'],
    queryFn: fetchReportsList,
    staleTime: 60_000,
  })

  const filteredReports = useMemo(() => {
    const list = Array.isArray(reportsQuery.data) ? [...reportsQuery.data] : []
    list.sort((a, b) => {
      const dateA = a?.created_at ? new Date(a.created_at).getTime() : 0
      const dateB = b?.created_at ? new Date(b.created_at).getTime() : 0
      return dateB - dateA
    })

    if (!searchTerm.trim()) return list
    const normalized = searchTerm.trim().toLowerCase()
    return list.filter((item) => {
      const haystack = [
        item.company_bin,
        item.name,
        item.email,
        item.purpose,
        item.comment,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalized)
    })
  }, [reportsQuery.data, searchTerm])

  const reportQuery = useQuery({
    queryKey: ['report', activeSessionId],
    queryFn: () => fetchReportBySession(activeSessionId),
    enabled: Boolean(activeSessionId),
    refetchInterval: shouldPoll ? 5000 : false,
  })

  const messagesQuery = useQuery({
    queryKey: ['messages', activeSessionId],
    queryFn: () => fetchMessagesBySession(activeSessionId),
    enabled: Boolean(activeSessionId),
    refetchInterval: shouldPoll ? 5000 : false,
  })

  const analyzeMutation = useMutation({
    mutationFn: analyzeStatements,
    onSuccess: (result) => {
      setSubmitError('')
      if (result?.sessionId) {
        setActiveSessionId(result.sessionId)
        setShouldPoll(true)
      }
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      setFiles([])
      setComment('')
    },
    onError: (error) => {
      setSubmitError(error?.message || 'Не удалось отправить файлы. Попробуйте ещё раз.')
    },
  })

  useEffect(() => {
    if (!shouldPoll || !reportQuery.data?.status) return
    if (['completed', 'failed'].includes(reportQuery.data.status)) {
      setShouldPoll(false)
      queryClient.invalidateQueries({ queryKey: ['reports'] })
    }
  }, [shouldPoll, reportQuery.data, queryClient])

  const handleFilesChange = (selectedFiles) => {
    const oversized = selectedFiles.find((file) => file.size > MAX_FILE_SIZE)
    if (oversized) {
      setSubmitError(
        `Файл "${oversized.name}" превышает допустимый размер 50 МБ. Пожалуйста, выберите другой файл.`,
      )
      return
    }
    setSubmitError('')
    setFiles((prev) => [...prev, ...selectedFiles])
  }

  const handleRemoveFile = (fileIndex) => {
    setFiles((prev) => prev.filter((_, index) => index !== fileIndex))
  }

  const handleSubmit = () => {
    if (files.length === 0) {
      setSubmitError('Добавьте хотя бы один файл для анализа.')
      return
    }
    setSubmitError('')
    analyzeMutation.mutate({
      comment: comment.trim(),
      files,
    })
  }

  const selectedReport = reportQuery.data ?? null
  const messages = messagesQuery.data ?? selectedReport?.messages ?? []

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>iKapitalist · Анализ выписок</h1>
          <p>Загрузите выписки, чтобы агент сформировал отчёт, и отслеживайте результаты в одной системе</p>
        </div>
      </header>

      <main className="app-grid">
        <div className="grid-left">
          <UploadPanel
            files={files}
            onFilesChange={handleFilesChange}
            onRemoveFile={handleRemoveFile}
            comment={comment}
            onCommentChange={setComment}
            onSubmit={handleSubmit}
            isSubmitting={analyzeMutation.isLoading}
            error={submitError}
          />

          <MessagesPanel
            messages={messages}
            isLoading={messagesQuery.isLoading || reportQuery.isLoading}
            status={selectedReport?.status}
            updatedAt={selectedReport?.updated_at || selectedReport?.completed_at}
          />
        </div>

        <div className="grid-right">
          <ReportsList
            reports={filteredReports}
            isLoading={reportsQuery.isLoading}
            onRefresh={() => reportsQuery.refetch()}
            onSelect={(sessionId) => {
              setActiveSessionId(sessionId)
              setShouldPoll(true)
            }}
            activeSessionId={activeSessionId}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
          />

          <ReportDetails report={selectedReport} isLoading={reportQuery.isLoading} />
        </div>
      </main>
    </div>
  )
}

export default App
