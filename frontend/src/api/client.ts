import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'

const client = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // A 401 from the AI provider proxy reflects the upstream provider rejecting
      // its own API key, not this app's session — don't treat it as a session
      // expiry (that would force-logout the user instead of letting the caller
      // fall back, e.g. smart search falling back to plain keyword search).
      const isAuthEndpoint = error.config?.url?.includes('/auth/')
        || error.config?.url?.includes('/ai-providers/proxy/')
      if (!isAuthEndpoint) {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('auth_user')
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default client
