; Removes the browser extension bridge on uninstall (registered per user when
; the user turned it on in Settings; see src/bridge/index.js).
!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.interviewhelper.bridge"
  ; Misspelled keys written by versions before 0.18.1 (removed only if empty).
  DeleteRegKey HKCU "Software\GoogleChrome\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey HKCU "Software\MicrosoftEdge\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey HKCU "Software\BraveSoftwareBrave-Browser\NativeMessagingHosts\com.interviewhelper.bridge"
  DeleteRegKey /ifempty HKCU "Software\GoogleChrome\NativeMessagingHosts"
  DeleteRegKey /ifempty HKCU "Software\GoogleChrome"
  DeleteRegKey /ifempty HKCU "Software\MicrosoftEdge\NativeMessagingHosts"
  DeleteRegKey /ifempty HKCU "Software\MicrosoftEdge"
  DeleteRegKey /ifempty HKCU "Software\BraveSoftwareBrave-Browser\NativeMessagingHosts"
  DeleteRegKey /ifempty HKCU "Software\BraveSoftwareBrave-Browser"
!macroend
