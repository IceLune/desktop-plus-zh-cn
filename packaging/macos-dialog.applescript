on run argv
	set titleText to "Desktop Plus 简体中文插件"
	try
		set choices to {"启动汉化版", "应用汉化", "恢复英文", "检查状态"}
		set picked to choose from list choices with title titleText with prompt "请选择操作"
		if picked is false then return
		set selectedAction to item 1 of picked
		if selectedAction is "启动汉化版" then
			set actionName to "launch"
		else if selectedAction is "应用汉化" then
			set actionName to "apply"
		else if selectedAction is "恢复英文" then
			set actionName to "restore"
		else
			set actionName to "check"
		end if

		set pathDialog to display dialog "使用应用程序文件夹里的 Desktop Plus，或选择其他位置的 Desktop Plus.app。" with title titleText buttons {"取消", "选择应用…", "使用默认位置"} default button "使用默认位置" cancel button "取消"
		set shellCommand to quoted form of (item 1 of argv) & " macos " & actionName
		if button returned of pathDialog is "选择应用…" then
			set selectedApp to choose file with prompt "请选择 Desktop Plus.app" of type {"com.apple.application-bundle"}
			set shellCommand to shellCommand & " " & quoted form of (POSIX path of selectedApp)
		end if
		set resultText to do shell script (shellCommand & " 2>&1")
		display dialog resultText with title titleText buttons {"确定"} default button "确定"
	on error errorText number errorNumber
		if errorNumber is not -128 then display alert titleText message errorText as critical
	end try
end run
