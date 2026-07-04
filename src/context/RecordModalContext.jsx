import { createContext, useContext, useState } from 'react'

/**
 * Global state for the "New recording" modal so any page (sidebar, hero card,
 * empty states) can trigger it without prop-drilling.
 */
const RecordModalContext = createContext({ open: false, setOpen: () => {} })

export function RecordModalProvider({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <RecordModalContext.Provider value={{ open, setOpen }}>
      {children}
    </RecordModalContext.Provider>
  )
}

export function useRecordModal() {
  return useContext(RecordModalContext)
}

export default RecordModalContext
