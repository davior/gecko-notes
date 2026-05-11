import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'

const client = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Inject auth token if present (set by settings store)
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('app_secret_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.warn('Unauthorized – check APP_SECRET_TOKEN')
    }
    return Promise.reject(error)
  }
)

export default client
