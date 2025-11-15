/**
 * Модуль для конвертации PDF выписок в JSON через Python-сервис
 * Использует алгоритм из /Users/mshaimard/pdf
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')

const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const mkdir = promisify(fs.mkdir)

// Путь к Python-сервису конвертации
// На Render.com путь будет /opt/render/project/src/pdf
// Локально: /Users/mshaimard/pdf или ./pdf
const PDF_SERVICE_PATH = process.env.PDF_SERVICE_PATH || 
  (process.env.NODE_ENV === 'production' 
    ? (process.env.RENDER ? '/opt/render/project/src/pdf' : './pdf')
    : '/Users/mshaimard/pdf')
const PDF_SERVICE_PORT = process.env.PDF_SERVICE_PORT || 8000
const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || `http://localhost:${PDF_SERVICE_PORT}`

/**
 * Конвертирует PDF файл в JSON через Python-сервис
 * @param {Buffer} pdfBuffer - Байты PDF файла
 * @param {string} filename - Имя файла
 * @returns {Promise<Array>} Массив с результатами конвертации
 */
async function convertPdfToJson(pdfBuffer, filename) {
  // Вариант 1: Вызов через HTTP (если сервис запущен)
  if (process.env.USE_PDF_SERVICE_HTTP === 'true' || process.env.USE_PDF_SERVICE_HTTP === '1') {
    return convertPdfToJsonViaHttp(pdfBuffer, filename)
  }
  
  // Вариант 2: Прямой вызов Python скрипта
  return convertPdfToJsonViaPython(pdfBuffer, filename)
}

/**
 * Конвертация через HTTP запрос к Python-сервису
 */
async function convertPdfToJsonViaHttp(pdfBuffer, filename) {
  const FormData = require('form-data')
  const axios = require('axios')
  
  const formData = new FormData()
  formData.append('files', pdfBuffer, {
    filename: filename,
    contentType: 'application/pdf'
  })

  try {
    const response = await axios.post(`${PDF_SERVICE_URL}/process`, formData, {
      headers: formData.getHeaders(),
      timeout: 300000, // 5 минут таймаут для больших файлов
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    })

    if (response.status === 204) {
      // Нет строк с кредитом
      return []
    }

    return Array.isArray(response.data) ? response.data : [response.data]
  } catch (error) {
    console.error('❌ Ошибка HTTP запроса к PDF-сервису:', error.message)
    if (error.response) {
      console.error('Response status:', error.response.status)
      console.error('Response data:', error.response.data)
    }
    throw new Error(`Не удалось конвертировать PDF через HTTP: ${error.message}`)
  }
}

/**
 * Конвертация через прямой вызов Python скрипта
 */
async function convertPdfToJsonViaPython(pdfBuffer, filename, customPdfServicePath = null) {
  const tempDir = path.join(__dirname, 'temp')
  const tempPdfPath = path.join(tempDir, `pdf_${Date.now()}_${filename}`)
  
  try {
    // Создаем временную директорию, если её нет
    if (!fs.existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true })
    }

    // Сохраняем PDF во временный файл
    await writeFile(tempPdfPath, pdfBuffer)
    console.log(`📄 PDF сохранен во временный файл: ${tempPdfPath}`)

    // Вызываем Python скрипт для конвертации
    // Используем path.resolve для правильной обработки относительных путей
    const servicePath = customPdfServicePath || PDF_SERVICE_PATH
    const resolvedPdfServicePath = path.isAbsolute(servicePath) 
      ? servicePath 
      : path.resolve(__dirname, servicePath)
    const pythonScript = path.join(resolvedPdfServicePath, 'app', 'cli.py')
    const pythonExecutable = process.env.PYTHON_PATH || 'python3'
    
    // Проверяем существование файла
    if (!fs.existsSync(pythonScript)) {
      console.error(`❌ Python скрипт не найден: ${pythonScript}`)
      console.error(`   PDF_SERVICE_PATH: ${PDF_SERVICE_PATH}`)
      console.error(`   resolvedPdfServicePath: ${resolvedPdfServicePath}`)
      console.error(`   __dirname: ${__dirname}`)
      console.error(`   NODE_ENV: ${process.env.NODE_ENV}`)
      console.error(`   RENDER: ${process.env.RENDER}`)
      
      // Пробуем альтернативные пути
      const alternativePaths = [
        path.join(__dirname, 'pdf', 'app', 'cli.py'),
        path.join(process.cwd(), 'pdf', 'app', 'cli.py'),
        '/opt/render/project/src/pdf/app/cli.py',
        './pdf/app/cli.py'
      ]
      
      for (const altPath of alternativePaths) {
        if (fs.existsSync(altPath)) {
          console.log(`✅ Найден альтернативный путь: ${altPath}`)
          // Используем найденный путь
          const altResolvedPath = path.dirname(path.dirname(altPath))
          return convertPdfToJsonViaPython(pdfBuffer, filename, altResolvedPath)
        }
      }
      
      throw new Error(`Python скрипт не найден: ${pythonScript}. Проверьте, что папка pdf загружена в репозиторий.`)
    }

    return new Promise((resolve, reject) => {
      // Проверяем, есть ли виртуальное окружение (для локальной разработки)
      const venvPython = path.join(resolvedPdfServicePath, 'venv', 'bin', 'python3')
      const venvPythonAlt = path.join(resolvedPdfServicePath, 'venv', 'bin', 'python')
      const venvExists = fs.existsSync(venvPython) || fs.existsSync(venvPythonAlt)
      
      let actualPythonExecutable = pythonExecutable
      let pythonEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
      
      // Функция для запуска Python процесса конвертации
      const runPythonConversion = () => {
        console.log(`🐍 Используем Python: ${actualPythonExecutable}`)
        console.log(`📁 Рабочая директория: ${resolvedPdfServicePath}`)
        
        // Запускаем как модуль, чтобы относительные импорты работали
        // Используем: python3 -m app.cli file.pdf --json
        // вместо: python3 app/cli.py file.pdf --json
        const pythonProcess = spawn(actualPythonExecutable, ['-m', 'app.cli', tempPdfPath, '--json'], {
          cwd: resolvedPdfServicePath,
          env: pythonEnv
        })

        let stdout = ''
        let stderr = ''

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        pythonProcess.on('close', async (code) => {
          // Удаляем временный файл
          try {
            await unlink(tempPdfPath)
          } catch (err) {
            console.warn('⚠️ Не удалось удалить временный файл:', err.message)
          }

          if (code !== 0) {
            console.error('❌ Python скрипт завершился с ошибкой:', stderr)
            reject(new Error(`Python скрипт завершился с кодом ${code}: ${stderr}`))
            return
          }

          try {
            // Проверяем, есть ли сообщение об отсутствии транзакций
            const stdoutTrimmed = stdout.trim()
            if (stdoutTrimmed === '' || stdoutTrimmed.includes('No credit rows found')) {
              console.log('⚠️ В PDF файле не найдено операций по кредиту')
              // Возвращаем пустой результат
              resolve([{
                source_file: filename,
                metadata: {},
                transactions: [],
                error: 'Не найдено операций по кредиту в PDF файле'
              }])
              return
            }

            // Python скрипт может выводить логи в stdout перед и после JSON
            // Ищем JSON блок в stdout (обычно это последний блок, начинающийся с [ или {)
            let jsonString = stdoutTrimmed
            
            // Пытаемся найти JSON блок - ищем последний блок, начинающийся с [ или {
            const jsonStartIndex = Math.max(
              stdoutTrimmed.lastIndexOf('['),
              stdoutTrimmed.lastIndexOf('{')
            )
            
            if (jsonStartIndex > 0) {
              // Найден JSON блок, извлекаем его
              let extractedJson = stdoutTrimmed.substring(jsonStartIndex)
              
              // Теперь нужно найти конец JSON - ищем последнюю закрывающую скобку
              // Для массива ищем последнюю ]
              // Для объекта ищем последнюю }
              let jsonEndIndex = extractedJson.length
              
              // Если это массив, ищем последнюю ]
              if (extractedJson.startsWith('[')) {
                const lastBracketIndex = extractedJson.lastIndexOf(']')
                if (lastBracketIndex > 0) {
                  jsonEndIndex = lastBracketIndex + 1
                }
              } 
              // Если это объект, ищем последнюю }
              else if (extractedJson.startsWith('{')) {
                const lastBraceIndex = extractedJson.lastIndexOf('}')
                if (lastBraceIndex > 0) {
                  jsonEndIndex = lastBraceIndex + 1
                }
              }
              
              jsonString = extractedJson.substring(0, jsonEndIndex)
              console.log(`📝 Извлечен JSON из stdout (пропущено ${jsonStartIndex} символов до JSON, ${extractedJson.length - jsonEndIndex} символов после)`)
            }

            // Парсим JSON
            const result = JSON.parse(jsonString)
            console.log(`✅ PDF конвертирован в JSON: найдено ${Array.isArray(result) ? result.length : 1} файл(ов)`)
            resolve(Array.isArray(result) ? result : [result])
          } catch (parseError) {
            console.error('❌ Ошибка парсинга JSON:', parseError.message)
            console.error('Stdout:', stdout)
            // Если это не JSON, но код успешный - возможно, нет транзакций
            if (code === 0 && stdout.trim().includes('No credit rows found')) {
              resolve([{
                source_file: filename,
                metadata: {},
                transactions: [],
                error: 'Не найдено операций по кредиту в PDF файле'
              }])
            } else {
              reject(new Error(`Не удалось распарсить JSON ответ: ${parseError.message}`))
            }
          }
        })

        pythonProcess.on('error', async (error) => {
          // Удаляем временный файл при ошибке
          try {
            await unlink(tempPdfPath)
          } catch (err) {
            // Игнорируем ошибку удаления
          }
          console.error('❌ Ошибка запуска Python процесса:', error.message)
          reject(new Error(`Не удалось запустить Python скрипт: ${error.message}`))
        })
      }
      
      if (venvExists) {
        // Локальная разработка с venv - запускаем сразу
        actualPythonExecutable = fs.existsSync(venvPython) ? venvPython : venvPythonAlt
        pythonEnv.VIRTUAL_ENV = path.join(resolvedPdfServicePath, 'venv')
        console.log(`✅ Найдено виртуальное окружение: ${actualPythonExecutable}`)
        runPythonConversion()
      } else {
        // Production (Docker или Render.com без venv)
        // В Docker все зависимости установлены глобально, просто запускаем
        console.log(`🐍 Используем системный Python: ${actualPythonExecutable}`)
        runPythonConversion()
      }
    })
  } catch (error) {
    // Удаляем временный файл при ошибке
    try {
      if (fs.existsSync(tempPdfPath)) {
        await unlink(tempPdfPath)
      }
    } catch (err) {
      // Игнорируем ошибку удаления
    }
    throw error
  }
}

/**
 * Конвертирует массив PDF файлов в JSON
 * @param {Array<{buffer: Buffer, filename: string}>} files - Массив файлов
 * @returns {Promise<Array>} Массив результатов конвертации
 */
async function convertPdfsToJson(files) {
  const results = []
  
  for (const file of files) {
    try {
      console.log(`🔄 Конвертирую PDF: ${file.filename}`)
      const result = await convertPdfToJson(file.buffer, file.filename)
      
      // Результат может быть массивом (если несколько файлов) или объектом
      if (Array.isArray(result)) {
        results.push(...result)
      } else {
        results.push(result)
      }
    } catch (error) {
      console.error(`❌ Ошибка конвертации файла ${file.filename}:`, error.message)
      // Добавляем ошибку в результат, чтобы пользователь видел, что произошло
      results.push({
        source_file: file.filename,
        metadata: {},
        transactions: [],
        error: error.message
      })
    }
  }
  
  return results
}

module.exports = {
  convertPdfToJson,
  convertPdfsToJson
}

