import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Info,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Inbox,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { analyzeStatements, fetchReportBySession, fetchReportsList, deleteReport } from './api/analysis'

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

const ReportsList = ({
  reports,
  isLoading,
  onRefresh,
  onSelect,
  onDelete,
  activeSessionId,
  searchTerm,
  onSearchChange,
  isRefreshing,
  deletingSessionId,
  error,
}) => (
  <section className="card reports-card">
    <header className="card-header">
      <div>
        <h2>История анализов</h2>
        <p>Последние заявки и статусы обработки</p>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={onRefresh}
        aria-label="Обновить список"
        disabled={isRefreshing}
      >
        {isRefreshing ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
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

      {error && (
        <div className="list-alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

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
            const commentTitle = (report.comment || '').trim()
            const primaryTitle =
              commentTitle || report.company_bin || report.name || report.email || 'Без названия'
            return (
              <li
                key={sessionKey}
                className={`reports-item ${
                  activeSessionId && activeSessionId === sessionKey ? 'reports-item-active' : ''
                }`}
              >
                <div
                  className="reports-item-content"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(sessionKey)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(sessionKey)
                    }
                  }}
                >
                  <div className="reports-item-header">
                    <strong>{primaryTitle}</strong>
                    <div className="reports-item-actions">
                      <StatusBadge status={report.status} />
                      <button
                        type="button"
                        className="icon-button icon-button-danger"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDelete(sessionKey)
                        }}
                        aria-label="Удалить анализ"
                        disabled={deletingSessionId === sessionKey}
                      >
                        {deletingSessionId === sessionKey ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="reports-item-meta">
                    <span>{report.name || report.email || '—'}</span>
                    <span>{formatDate(report.created_at)}</span>
                  </div>
                  {report.company_bin && <p className="reports-item-comment">{report.company_bin}</p>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  </section>
)

const ReportDetails = ({ report, isLoading, isFetching, error, onRefresh, hasSelection }) => {
  const renderContent = () => {
    if (!hasSelection) {
      return (
        <EmptyState
          title="Выберите анализ"
          description="Итоговый отчёт появится здесь. Нажмите на заявку в списке слева."
        />
      )
    }

    if (isLoading || isFetching) {
      return (
        <div className="loading-state">
          <Loader2 size={20} className="spin" />
          <span>Загружаем подробности...</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="list-alert" style={{ margin: '0 0 16px' }}>
          <AlertCircle size={16} />
          <span>{error.message || 'Не удалось загрузить отчёт.'}</span>
        </div>
      )
    }

    if (!report) {
      return (
        <EmptyState
          title="Отчёт недоступен"
          description="Похоже, сервер не вернул детали. Обновите страницу или повторите попытку позже."
          icon={AlertCircle}
        />
      )
    }

    let filesList = []
    if (report.files_data) {
      try {
        const parsed = JSON.parse(report.files_data)
        if (Array.isArray(parsed)) {
          filesList = parsed
        }
      } catch {
        filesList = []
      }
    }

    return (
      <>
        <div className="details-grid">
          <div className="details-item">
            <span className="details-label">Статус</span>
            <span style={{ display: 'inline-flex' }}>
              <StatusBadge status={report.status} />
            </span>
          </div>
          <div className="details-item">
            <span className="details-label">Сессия</span>
            <span>{report.session_id}</span>
          </div>
          <div className="details-item">
            <span className="details-label">Создан</span>
            <span>{formatDate(report.created_at)}</span>
          </div>
          <div className="details-item">
            <span className="details-label">Завершён</span>
            <span>{formatDate(report.completed_at)}</span>
          </div>
          <div className="details-item">
            <span className="details-label">Контакт</span>
            <span>{report.name || report.email || report.phone || '—'}</span>
          </div>
          <div className="details-item">
            <span className="details-label">Комментарий</span>
            <span>{report.comment || '—'}</span>
          </div>
        </div>

        {filesList.length > 0 && (
          <div className="details-report">
            <h3>Прикреплённые файлы</h3>
            <article>
              {filesList.map((file) => (
                <div key={`${file.file_id || file.name}`}>
                  <strong>{file.name || 'Файл'}</strong>{' '}
                  {typeof file.size === 'number' ? `· ${formatFileSize(file.size)}` : null}{' '}
                  {file.mime ? `· ${file.mime}` : null}
                </div>
              ))}
            </article>
          </div>
        )}

        <div className="details-report">
          <h3>Отчёт</h3>
          <article>
            {report.report_text ? report.report_text.trim() : 'Агент не вернул текст отчёта.'}
          </article>
        </div>
      </>
    )
  }

  return (
    <section className="card">
      <header className="card-header">
        <div>
          <h2>Детали анализа</h2>
          <p>Подробности выбранной заявки и итоговый отчёт агента</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => onRefresh?.()}
          aria-label="Обновить детали"
          disabled={!hasSelection || isLoading || isFetching}
        >
          {isLoading || isFetching ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
        </button>
      </header>
      <div className="card-body">{renderContent()}</div>
    </section>
  )
}

function App() {
  const queryClient = useQueryClient()
  const [files, setFiles] = useState([])
  const [comment, setComment] = useState('')
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [submitError, setSubmitError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [listError, setListError] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [forceSpinner, setForceSpinner] = useState(false)
  const reloadTimerRef = useRef(null)
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)

  const reportsQuery = useQuery({
    queryKey: ['reports'],
    queryFn: fetchReportsList,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (reportsQuery.data) {
      console.log('📋 Список отчётов загружен', reportsQuery.data)
    }
    if (reportsQuery.error) {
      console.error('❌ Ошибка загрузки списка отчётов', reportsQuery.error)
    }
  }, [reportsQuery.data, reportsQuery.error])

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
    refetchInterval: false,
  })

  useEffect(() => {
    if (reportQuery.data) {
      console.log('📄 Данные отчёта получены', reportQuery.data)
    }
    if (reportQuery.error) {
      console.error('❌ Ошибка загрузки отчёта', reportQuery.error)
    }
  }, [reportQuery.data, reportQuery.error])

  const analyzeMutation = useMutation({
    mutationFn: analyzeStatements,
    onSuccess: (result) => {
      setSubmitError('')
      if (result?.sessionId) {
        setActiveSessionId(result.sessionId)
      }
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      setFiles([])
      setComment('')
    },
    onError: (error) => {
      setSubmitError(error?.message || 'Не удалось отправить файлы. Попробуйте ещё раз.')
      setForceSpinner(false)
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current)
        reloadTimerRef.current = null
      }
    },
  })

  const deleteReportMutation = useMutation({
    mutationFn: deleteReport,
    onMutate: (sessionId) => {
      setPendingDelete(sessionId)
      setListError('')
    },
    onSuccess: (_data, sessionId) => {
      if (activeSessionId === sessionId) {
        setActiveSessionId(null)
        queryClient.removeQueries({ queryKey: ['report', sessionId] })
      }
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      setPendingDelete(null)
    },
    onError: (error) => {
      setListError(error?.message || 'Не удалось удалить анализ. Попробуйте снова.')
      setPendingDelete(null)
    },
  })

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current)
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

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
    if (forceSpinner) return
    if (files.length === 0) {
      setSubmitError('Добавьте хотя бы один файл для анализа.')
      return
    }
    setSubmitError('')
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current)
    }
    setForceSpinner(true)
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
    }
    setToast({
      type: 'info',
      text: 'Выписки отправлены на анализ. Обновите историю позже, чтобы увидеть результат.',
    })
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 5000)
    reloadTimerRef.current = setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    }, 4000)
    analyzeMutation.mutate({
      comment: comment.trim(),
      files,
    })
  }

  const handleRefreshReports = async () => {
    setListError('')

    const tasks = [reportsQuery.refetch()]
    if (activeSessionId) {
      tasks.push(reportQuery.refetch())
    }

    try {
      const results = await Promise.all(tasks)
      const failed = results.find((result) => result.error)
      if (failed?.error) {
        setListError(failed.error.message || 'Не удалось обновить данные.')
      }
    } catch (error) {
      setListError(error?.message || 'Не удалось обновить данные.')
    }
  }

  const handleDeleteReport = (sessionId) => {
    if (!sessionId) return
    const confirmDelete = window.confirm('Удалить выбранный анализ? Это действие необратимо.')
    if (!confirmDelete) return
    deleteReportMutation.mutate(sessionId)
  }

  return (
    <div className="app">
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status">
          {toast.type === 'info' ? <InfoIcon /> : null}
          <span>{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => {
              setToast(null)
              if (toastTimerRef.current) {
                clearTimeout(toastTimerRef.current)
                toastTimerRef.current = null
              }
            }}
            aria-label="Закрыть уведомление"
          >
            <X size={14} />
          </button>
        </div>
      )}
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
            isSubmitting={analyzeMutation.isLoading || forceSpinner}
            error={submitError}
          />
        </div>

        <div className="grid-right">
          <ReportsList
            reports={filteredReports}
            isLoading={reportsQuery.isLoading}
            onRefresh={handleRefreshReports}
            onSelect={(sessionId) => {
              setActiveSessionId(sessionId)
            }}
            onDelete={handleDeleteReport}
            activeSessionId={activeSessionId}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            isRefreshing={reportsQuery.isFetching}
            deletingSessionId={pendingDelete}
            error={listError}
          />
          <ReportDetails
            report={reportQuery.data}
            isLoading={reportQuery.isLoading}
            isFetching={reportQuery.isFetching}
            error={reportQuery.error}
            onRefresh={() => {
              if (activeSessionId) {
                reportQuery.refetch()
              }
            }}
            hasSelection={Boolean(activeSessionId)}
          />
        </div>
      </main>
    </div>
  )
}

export default App

const InfoIcon = () => <Info size={14} />
