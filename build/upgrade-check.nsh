; 覆盖安装确认。
; 由 package.json 的 build.nsis.include 引入，挂在 customInit 上——
; 它在 initMultiUser 之后执行，此时 $INSTDIR 已经按注册表里的旧位置设定好了。
;
; 要同时看两处注册表：本安装包默认 per-user（HKCU），但用户上次可能选了
; "为所有用户安装"（HKLM，装到 Program Files 之类的位置）。只看 HKCU 的话，
; 这种机器会被当成全新安装，悄悄装出第二份。

!macro customInit
  ; 静默安装（/S）不弹框，直接走覆盖；但仍要先关进程
  IfSilent ci_overwrite 0

  ; ---------- 1. 当前用户安装 ----------
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" ci_check_allusers
  ; 注册表有记录但文件被手工删掉时，当作全新安装，别拿提示吓人
  IfFileExists "$R0\${APP_EXECUTABLE_FILENAME}" 0 ci_check_allusers

  ReadRegStr $R1 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $R1 == ""
    StrCpy $R1 "?"
  ${EndIf}
  ; 2052 = zh-CN。安装包只有中英两种向导语言，用 $LANGUAGE 判断比 LangString 稳
  ${If} $LANGUAGE == 2052
    StrCpy $R2 "检测到已安装 PostureGuard $R1（仅当前用户）。$\r$\n$\r$\n安装位置：$R0$\r$\n$\r$\n是否覆盖安装到该位置？$\r$\n安装程序会先关闭正在运行的 PostureGuard。"
  ${Else}
    StrCpy $R2 "PostureGuard $R1 is already installed for the current user.$\r$\n$\r$\nLocation: $R0$\r$\n$\r$\nOverwrite that installation?$\r$\nThe running PostureGuard will be closed first."
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "$R2" IDYES ci_overwrite IDNO ci_abort

  ; ---------- 2. 所有用户安装 ----------
ci_check_allusers:
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; 有的版本只把路径写在卸载项里，补一层兜底
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  StrCmp $R0 "" ci_done
  IfFileExists "$R0\${APP_EXECUTABLE_FILENAME}" 0 ci_done

  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $R1 == ""
    StrCpy $R1 "?"
  ${EndIf}
  ${If} $LANGUAGE == 2052
    StrCpy $R2 "检测到已为所有用户安装 PostureGuard $R1。$\r$\n$\r$\n安装位置：$R0$\r$\n$\r$\n覆盖它对所有用户生效，需要管理员权限。是否继续？$\r$\n安装程序会先关闭正在运行的 PostureGuard。"
    StrCpy $R5 "这个安装程序当前没有以管理员身份运行，无法覆盖“所有用户”的安装。$\r$\n$\r$\n请右键点击安装包，选择“以管理员身份运行”后重试。"
  ${Else}
    StrCpy $R2 "PostureGuard $R1 is installed for all users.$\r$\n$\r$\nLocation: $R0$\r$\n$\r$\nOverwriting it affects every user and needs administrator rights. Continue?$\r$\nThe running PostureGuard will be closed first."
    StrCpy $R5 "This installer is not running as administrator, so it cannot overwrite an all-users installation.$\r$\n$\r$\nRight-click the installer and choose $\"Run as administrator$\", then try again."
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "$R2" IDYES ci_allusers IDNO ci_abort

ci_allusers:
  ${IfNot} ${UAC_IsAdmin}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$R5"
    Quit
  ${EndIf}
  ; 切到"所有用户"模式并装回原处：setInstallModePerAllUsers 会把 $INSTDIR
  ; 重设成 Program Files 的默认路径，所以之后必须再写一次
  !insertmacro setInstallModePerAllUsers
  StrCpy $INSTDIR "$R0"
  Goto ci_overwrite

ci_abort:
  Quit

ci_overwrite:
  ; 运行中的 exe 是被锁住的，不先关掉，覆盖会失败或留下半个版本。
  ; Electron 是多进程，按映像名整批杀；主窗口的 close 被 preventDefault 拦着，
  ; 所以只能强杀——程序没有未落盘的运行时状态，代价只是这一轮要重新标定。
  ; 不用 nsProcess 判断"是否在运行"：taskkill 对不存在的进程本来就无害，
  ; 少一个插件依赖就少一处编译期风险。
  nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /F`
  Pop $R4
  Sleep 1000

ci_done:
!macroend
