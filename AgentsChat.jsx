import React, { useState, useRef, useEffect } from 'react'
import { Send, User, Paperclip, RotateCcw } from 'lucide-react'
import PrivacyPolicyModal from './PrivacyPolicyModal'
import { getApiUrl } from '../utils/api'
import './AgentsChat.css'

// Иконка с буквами "iK" для iKapitalist
const AIIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="url(#ikGradient)" />
    <text 
      x="12" 
      y="16" 
      fontFamily="system-ui, -apple-system, sans-serif" 
      fontSize="11" 
      fontWeight="700" 
      fill="white" 
      textAnchor="middle"
    >
      iK
    </text>
    <defs>
      <linearGradient id="ikGradient" x1="2" y1="2" x2="22" y2="22">
        <stop stopColor="#667eea" />
        <stop offset="1" stopColor="#764ba2" />
      </linearGradient>
    </defs>
  </svg>
)

const AgentsChat = ({ onProgressChange }) => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: "Здравствуйте, как я могу к Вам обращаться?",
      sender: 'bot',
      timestamp: new Date()
    }
  ])
  const [inputMessage, setInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [selectedFiles, setSelectedFiles] = useState([])
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [dialogState, setDialogState] = useState('greeting') // greeting, name_collected, post_terms_choice, info_mode, data_collection
  const [userName, setUserName] = useState('')
  const [isCompleted, setIsCompleted] = useState(false) // Флаг завершения заявки
  const [infoSessionId, setInfoSessionId] = useState(null)
  const [currentAgent, setCurrentAgent] = useState('investment')
  const [applyPromptShown, setApplyPromptShown] = useState(false)
  const fileInputRef = useRef(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }
  // Форматирование чисел: 10000000 -> 10 000 000 (только отображение)
  const formatNumbersForDisplay = (text) => {
    if (!text || typeof text !== 'string') return text
    return text.replace(/\b\d{4,}\b/g, (num) => num.replace(/\B(?=(\d{3})+(?!\d))/g, ' '))
  }

  // Форматирование чисел для поля ввода (убираем пробелы перед отправкой)
  const formatInputNumbers = (text) => {
    if (!text || typeof text !== 'string') return text
    return text.replace(/\b\d{4,}\b/g, (num) => num.replace(/\B(?=(\d{3})+(?!\d))/g, ' '))
  }

  // Убираем пробелы из чисел перед отправкой
  const cleanNumbersForSending = (text) => {
    if (!text || typeof text !== 'string') return text
    return text.replace(/\b(\d{1,3}(?:\s\d{3})*)\b/g, (match) => match.replace(/\s/g, ''))
  }



  // Функция для создания сообщения бота
  const createBotMessage = (text, options = {}) => ({
    id: Date.now() + (options.idOffset || 1),
    text,
    sender: 'bot',
    timestamp: new Date(),
    ...options
  })

  // Функция для создания сообщения пользователя  
  const createUserMessage = (text, files = []) => {
    const filesText = files.length > 0 
      ? (files.length === 1 ? ` (файл: ${files[0].name})` : ` (файлов: ${files.length})`)
      : ''
    return {
      id: Date.now(),
      text: text + filesText,
      sender: 'user',
      timestamp: new Date()
    }
  }

  // Общая функция для отправки сообщений к агенту
  const sendToAgent = async (messageText, files = [], options = {}) => {
    setIsLoading(true)

    try {
      const agentType = options.agent || currentAgent || 'investment'
      const sessionIdOverride = options.sessionIdOverride || (agentType === 'information' ? infoSessionId : sessionId)

      // Подготавливаем FormData для отправки файлов
      const formData = new FormData()
      formData.append('text', messageText)
      formData.append('agent', agentType)
      if (sessionIdOverride) {
        formData.append('sessionId', sessionIdOverride)
      }
      if (files && files.length > 0) {
        // Отправляем массив файлов
        files.forEach(file => {
          formData.append('files', file)
        })
      }

      // call backend server
      const resp = await fetch(getApiUrl('/api/agents/run'), {
        method: 'POST',
        body: formData
      })
      
      // Проверяем статус ответа перед парсингом JSON
      if (!resp.ok) {
        let errorText = "Произошла ошибка. Попробуйте еще раз."
        try {
          const errorResult = await resp.json()
          errorText = errorResult.error || errorResult.message || errorText
          
          // Специальная обработка ошибки размера файла
          if (errorResult.code === 'FILE_TOO_LARGE') {
            errorText = errorResult.error || 'Размер файла превышает 50 МБ. Пожалуйста, выберите файл меньшего размера.'
          }
          
          // Обработка ошибки длины текста
          if (errorResult.code === 'TEXT_TOO_LONG') {
            errorText = errorResult.error || 'Сообщение слишком длинное. Максимальная длина: 200 символов.'
          }
          
          console.error('⚠️ Сервер вернул ошибку:', errorResult)
        } catch (parseError) {
          console.error('⚠️ Ошибка парсинга ответа сервера:', parseError)
          errorText = `Ошибка сервера (${resp.status})`
        }
        const errorMessage = createBotMessage(errorText)
        setMessages(prev => [...prev, errorMessage])
        return false // Возвращаем false для индикации ошибки
      }
      
      const result = await resp.json()
      
      // Сохраняем sessionId для следующих запросов
      if (result.sessionId) {
        if (agentType === 'information') {
          setInfoSessionId(result.sessionId)
        } else {
          setSessionId(result.sessionId)
        }
      }
      
      // Проверяем, был ли запрос успешным
      if (result.ok === false) {
        console.error('⚠️ Сервер вернул ошибку:', result.message || result.error)
        const errorMessage = createBotMessage(
          result.message || result.error || "Произошла ошибка. Попробуйте еще раз."
        )
        setMessages(prev => [...prev, errorMessage])
        return false // Возвращаем false для индикации ошибки
      }
      
      const botMessage = createBotMessage(result.message)
      setMessages(prev => [...prev, botMessage])

      // Обновляем прогресс по факту файлов из ответа сервера (если пришел)
      if (result?.data?.progress) {
        onProgressChange?.(prev => ({ ...prev, ...result.data.progress }))
      }
      
      // Проверяем, завершена ли заявка  
      if (result.completed) {
        setIsCompleted(true)
        // Очищаем sessionId после завершения заявки
        localStorage.removeItem('ikap_sessionId')
      }
      
      return true // Возвращаем true для индикации успеха
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения:', error)
      const errorMessage = createBotMessage("Извините, произошла ошибка. Попробуйте еще раз.")
      setMessages(prev => [...prev, errorMessage])
      return false
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])
  
  // Инициализация sessionId из localStorage при первой загрузке
  useEffect(() => {
    const savedSessionId = localStorage.getItem('ikap_sessionId')
    if (savedSessionId) {
      setSessionId(savedSessionId)
    }
  }, [])

  // Сохранение sessionId в localStorage для продолжения диалога с сервером
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem('ikap_sessionId', sessionId)
    }
  }, [sessionId])
  

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files || [])
    if (files.length > 0) {
      // Проверяем размер каждого файла (максимум 50 МБ)
      const maxSize = 50 * 1024 * 1024 // 50 МБ в байтах
      const oversizedFiles = files.filter(f => f.size > maxSize)
      
      if (oversizedFiles.length > 0) {
        // Показываем ошибку только если файл превышает лимит
        const errorMessage = oversizedFiles.length === 1
          ? `Файл "${oversizedFiles[0].name}" превышает допустимый размер (50 МБ). Пожалуйста, выберите файл меньшего размера.`
          : `Некоторые файлы превышают допустимый размер (50 МБ). Пожалуйста, выберите файлы меньшего размера.`
        
        const errorBotMessage = createBotMessage(errorMessage)
        setMessages(prev => [...prev, errorBotMessage])
        
        // Очищаем input
        if (event.target) {
          event.target.value = ''
        }
        return
      }
      
      setSelectedFiles(files)
      // НЕ добавляем текст в поле ввода - файлы отображаются отдельно снизу
      setInputMessage('')
    }
    // Сбрасываем input, чтобы можно было выбрать те же файлы снова
    if (event.target) {
      event.target.value = ''
    }
  }

  const handleSendMessage = async () => {
    if ((!inputMessage.trim() && selectedFiles.length === 0) || isLoading) return

    if (dialogState === 'post_terms_choice') {
      const reminderMessage = createBotMessage(
        'Пожалуйста, выберите один из вариантов: узнать подробнее о платформе или перейти к подаче заявки.'
      )
      setMessages(prev => [...prev, reminderMessage])
      setInputMessage('')
      setSelectedFiles([])
      return
    }

    // Очищаем числа от пробелов перед отправкой
    const cleanMessageText = cleanNumbersForSending(inputMessage.trim())
    const userMessage = createUserMessage(cleanMessageText, selectedFiles)
    
    // Сохраняем данные перед очисткой полей
    const messageText = cleanMessageText
    const filesToSend = [...selectedFiles]
    
    // СРАЗУ очищаем поля ввода перед добавлением сообщения в чат
    setInputMessage('')
    setSelectedFiles([])
    
    // Добавляем сообщение в чат после очистки полей
    setMessages(prev => [...prev, userMessage])
    
    // Обработка состояний диалога
    if (dialogState === 'greeting') {
      setUserName(messageText)
      setDialogState('name_collected')
      setCurrentAgent('investment')
      
      // Показываем спинер на 3 секунды
      setIsLoading(true)
      
      setTimeout(() => {
        const botMessage = createBotMessage(
          `Здравствуйте, ${messageText}! Наша платформа помогает бизнесу привлекать финансирование от 10 млн до 1 млрд ₸ от 2,5% в месяц. Срок займа — 4–36 месяцев. Быстрое одобрение, прозрачные условия, инвесторы, готовые поддержать ваш проект. Примите условия платформы, чтобы продолжить.`,
          { showTermsButton: true }
        )
        
        setMessages(prev => [...prev, botMessage])
        setIsLoading(false)
      }, 3000)
      
      return
    }
    
    if (dialogState === 'name_collected') {
      // Пользователь не должен отвечать здесь - модальное окно должно быть открыто
      return
    }
    
    const agentForMessage = currentAgent === 'information' ? 'information' : 'investment'
    
    if (dialogState === 'info_mode') {
      await sendToAgent(messageText, filesToSend, { agent: agentForMessage })
      return
    }
    
    if (dialogState === 'terms_accepted') {
      setDialogState('data_collection')
      await sendToAgent(messageText, filesToSend, { agent: agentForMessage })
      return
    }
    
    if (dialogState === 'data_collection') {
      await sendToAgent(messageText, filesToSend, { agent: agentForMessage })
    }
    // Если не в режиме сбора данных, поля уже очищены выше
  }

  const handleShowTerms = () => {
    setShowPrivacyModal(true)
  }

  const handleAcceptTerms = () => {
    setShowPrivacyModal(false)
    setDialogState('post_terms_choice')
    setCurrentAgent('investment')
    setApplyPromptShown(false)
    
    // Показываем спиннер перед выводом вариантов
    setIsLoading(true)
    
    setTimeout(() => {
      const botMessage = createBotMessage(
        'Отлично! Вы можете узнать подробнее о платформе или сразу перейти к подаче заявки. Что предпочитаете?',
        {
          choiceButtons: [
            { label: 'Узнать подробнее о платформе', value: 'info' },
            { label: 'Перейти к подаче заявки', value: 'apply' }
          ]
        }
      )
      setMessages(prev => [...prev, botMessage])
      setIsLoading(false)
    }, 1500)
  }

  const handleDeclineTerms = () => {
    setShowPrivacyModal(false)
    
    const botMessage = createBotMessage(
      "Для продолжения необходимо принять условия платформы. Если у вас есть вопросы, обратитесь к нам по email info@ikapitalist.kz"
    )
    setMessages(prev => [...prev, botMessage])
  }

  const handleChoiceSelection = async (choice) => {
    if (isLoading) return

    setMessages(prev => prev.map(msg => {
      if (!msg.choiceButtons) return msg
      const filteredButtons = msg.choiceButtons.filter(btn => btn.value !== choice)
      if (filteredButtons.length === msg.choiceButtons.length) {
        return msg
      }
      if (filteredButtons.length === 0) {
        const { choiceButtons, ...rest } = msg
        return rest
      }
      return { ...msg, choiceButtons: filteredButtons }
    }))

    if (choice === 'info') {
      if (dialogState === 'info_mode' && currentAgent === 'information') {
        return
      }

      const presetText = 'Пожалуйста, расскажите подробнее о платформе iKapitalist.'
      const userMessage = createUserMessage(presetText)
      setMessages(prev => [...prev, userMessage])

      setCurrentAgent('information')
      setDialogState('info_mode')

      if (!applyPromptShown) {
        const helperMessage = createBotMessage(
          'Вы можете задавать уточняющие вопросы о платформе. Когда будете готовы перейти к подаче заявки, нажмите кнопку ниже.',
          {
            choiceButtons: [
              { label: 'Перейти к подаче заявки', value: 'apply' }
            ]
          }
        )
        setMessages(prev => [...prev, helperMessage])
        setApplyPromptShown(true)
      }

      await sendToAgent(presetText, [], { agent: 'information' })
      return
    }

    if (choice === 'apply') {
      if (dialogState === 'data_collection' && currentAgent === 'investment') {
        return
      }

      const userMessage = createUserMessage('Перейти к подаче заявки')
      setMessages(prev => [...prev, userMessage])

      setCurrentAgent('investment')
      setDialogState('data_collection')
      setApplyPromptShown(false)

      // Показываем спиннер перед переходом к вопросам заявки
      setIsLoading(true)
      setTimeout(() => {
        const botMessage = createBotMessage('Какую сумму в тенге Вы хотите получить?')
        setMessages(prev => [...prev, botMessage])
        setIsLoading(false)
      }, 800)
    }
  }

  const handleHardReset = () => {
    // Полная очистка локальной сессии и чата
    try {
      localStorage.removeItem('ikap_sessionId')
    } catch {}
    setSessionId(null)
    setInfoSessionId(null)
    setSelectedFiles([])
    setIsCompleted(false)
    setDialogState('greeting')
    setCurrentAgent('investment')
    setApplyPromptShown(false)
    setUserName('')
    setInputMessage('')
    setMessages([
      {
        id: 1,
        text: "Здравствуйте, как я могу к Вам обращаться?",
        sender: 'bot',
        timestamp: new Date()
      }
    ])
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="agents-chat-container">
      <PrivacyPolicyModal 
        isOpen={showPrivacyModal}
        onClose={handleDeclineTerms}
        onAccept={handleAcceptTerms}
      />
      
      <div className="agents-chat-header">
        <div className="agents-chat-title">
          <AIIcon size={28} />
          <span>iKapitalist AI</span>
        </div>
        <button
          onClick={handleHardReset}
          className="restart-button"
          title="Новая заявка"
          style={{
            display: 'flex',
            alignItems: 'center',
            background: 'transparent',
            border: 'none',
            color: '#fff',
            cursor: 'pointer',
            padding: 0
          }}
        >
          <RotateCcw size={20} />
        </button>
      </div>

      <div className="agents-chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.sender}`}>
            <div className="message-avatar">
              {message.sender === 'bot' ? <AIIcon size={22} /> : <User size={20} />}
            </div>
            <div className="message-content">
              <div className="message-text">{formatNumbersForDisplay(message.text)}</div>
              {message.showTermsButton && (
                <div className="message-actions">
                  <button 
                    onClick={handleShowTerms}
                    className="terms-button"
                  >
                    Принять условия платформы
                  </button>
                </div>
              )}
              {message.choiceButtons && (
                <div className="message-actions">
                  {message.choiceButtons.map((button) => (
                    <button
                      key={button.value}
                      onClick={() => handleChoiceSelection(button.value)}
                      className="choice-button"
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="message-time">
                {message.timestamp.toLocaleTimeString('ru-RU', { 
                  hour: '2-digit', 
                  minute: '2-digit' 
                })}
              </div>
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="message bot">
            <div className="message-avatar">
              <AIIcon size={22} />
            </div>
            <div className="message-content">
              <div className="message-text">
                <div className="loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <div className="agents-chat-input">
        {isCompleted ? (
          <div className="completion-message">
            <div className="completion-text">
              ✅ Заявка завершена. Спасибо за предоставленную информацию! Мы анализируем ваши документы и свяжемся с вами в ближайшее время.
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="new-application-button"
              style={{
                marginTop: '15px',
                padding: '12px 24px',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '600',
                boxShadow: '0 4px 15px rgba(102, 126, 234, 0.3)',
                transition: 'all 0.3s ease'
              }}
            >
              Подать новую заявку
            </button>
          </div>
        ) : (
          <div className="input-container">
            <div className="input-row">
            <textarea
              value={inputMessage}
              onChange={(e) => {
                // Ограничиваем длину до 200 символов
                const text = e.target.value
                if (text.length <= 200) {
                  setInputMessage(text)
                }
              }}
              onKeyPress={handleKeyPress}
              placeholder="Напишите сообщение..."
              className="message-input"
              rows="1"
              maxLength={200}
              inputMode={dialogState === 'data_collection' && currentAgent !== 'information' ? 'numeric' : 'text'}
            />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="attach-button"
                title="Прикрепить файлы"
              >
                <Paperclip size={20} />
              </button>
              <button
                onClick={handleSendMessage}
                disabled={(!inputMessage.trim() && selectedFiles.length === 0) || isLoading}
                className="send-button"
              >
                <Send size={20} />
              </button>
            </div>
            {selectedFiles.length > 0 && (
              <div className="selected-files">
                {selectedFiles.map((file, index) => (
                  <div key={index} className="selected-file">
                    <span>📎 {file.name}</span>
                    <button 
                      onClick={() => {
                        const newFiles = [...selectedFiles]
                        newFiles.splice(index, 1)
                        setSelectedFiles(newFiles)
                        // Поле ввода остается пустым - файлы отображаются отдельно
                      }}
                      className="remove-file"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          accept=".pdf,application/pdf,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
}

export default AgentsChat
