import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { useProject } from './project.jsx'

const ConfirmContext = createContext(null)
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null)
  const pending = useRef(null)
  const origin = useRef(null)

  const confirm = useCallback((options) => {
    if (pending.current) return Promise.resolve(false)
    origin.current = document.activeElement
    return new Promise(resolve => {
      pending.current = resolve
      setRequest(options)
    })
  }, [])

  function settle(answer) {
    const resolve = pending.current
    pending.current = null
    setRequest(null)
    resolve?.(answer)
  }

  return <ConfirmContext.Provider value={confirm}>
    {children}
    <AlertDialog open={Boolean(request)} onOpenChange={open => { if (!open && pending.current) settle(false) }}>
      {request && <AlertDialogContent className="confirm-dialog" onCloseAutoFocus={event => {
        event.preventDefault()
        if (origin.current?.isConnected) origin.current.focus({ preventScroll: true })
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.detail}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>取消</AlertDialogCancel>
          <AlertDialogAction variant={request.danger ? 'destructive' : 'default'} onClick={() => settle(true)}>
            {request.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
  </ConfirmContext.Provider>
}

export function useUnsavedChanges(dirty, detail, { guardNavigation = true } = {}) {
  const confirm = useConfirm()
  const { setNavigationGuard } = useProject()
  const canLeave = useCallback(() => !dirty || confirm({ title: '放弃本次修改？', detail, action: '放弃修改', danger: true }), [dirty, detail, confirm])

  useEffect(() => {
    if (!dirty) return
    const remove = guardNavigation ? setNavigationGuard(canLeave) : null
    const beforeUnload = event => { event.preventDefault(); event.returnValue = true }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { remove?.(); window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirty, canLeave, setNavigationGuard, guardNavigation])

  const leave = action => {
    if (guardNavigation) setNavigationGuard(null)
    return action()
  }
  return { leave, close: async action => { if (await canLeave()) return leave(action) } }
}
