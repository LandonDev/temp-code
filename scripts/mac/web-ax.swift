// Measure Chromium AX trees, actions, focus, load notifications and window pixels.
// Build: swiftc web-ax.swift -o /private/tmp/web-ax
// Read: echo '{"op":"sample"}' | /private/tmp/web-ax <scratch-pid>
// Mutate: add --profile=/private/tmp/tc-web-measure/run-.../profile-... .
// JSONL stdin/stdout; ids live only for this probe process. Use web-measure.ts
// for the five-minute idle gate, one-second watchdog, process tracking and cleanup.
// --gate reads native CGSession/display state without an AX walk or a prompt.
// --self-test tests guards/serialization without starting an app or sending input.
// --cover x y w h --profile=... creates the inert normal-level scratch cover.
// --anchor x y w h --profile=... activates a separate tiny scratch focus window.
// No accessibility or screen-recording permission is requested by this script.
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
func emit(_ d:[String:Any]) {
    if let data=try? JSONSerialization.data(withJSONObject:d,options:[.sortedKeys]),
       let text=String(data:data,encoding:.utf8) { print(text); fflush(stdout) }
}
func gateState()->[String:Any] {
    let state=CGSessionCopyCurrentDictionary() as? [String:Any] ?? [:]
    return ["locked":state["CGSSessionScreenIsLocked"] as? Bool ?? state.isEmpty,
            "onConsole":state["kCGSSessionOnConsoleKey"] as? Bool ?? false,
            "displayAsleep":CGDisplayIsAsleep(CGMainDisplayID()) != 0,
            "axTrusted":AXIsProcessTrusted()]
}
func processText(_ pid:pid_t)->String {
    let p=Process();p.executableURL=URL(fileURLWithPath:"/bin/ps")
    p.arguments=["-p",String(pid),"-o","command="]
    let pipe=Pipe();p.standardOutput=pipe;p.standardError=FileHandle.nullDevice
    do { try p.run(); let d=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit()
        return String(data:d,encoding:.utf8) ?? ""
    } catch { return "" }
}
func idleSeconds()->Double {
    let p=Process();p.executableURL=URL(fileURLWithPath:"/usr/sbin/ioreg");p.arguments=["-c","IOHIDSystem"]
    let pipe=Pipe();p.standardOutput=pipe;p.standardError=FileHandle.nullDevice
    do { try p.run(); let d=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit()
        let text=String(data:d,encoding:.utf8) ?? ""
        let regex=try NSRegularExpression(pattern:"\"HIDIdleTime\" = ([0-9]+)")
        if let m=regex.firstMatch(in:text,range:NSRange(text.startIndex...,in:text)),
           let r=Range(m.range(at:1),in:text),let ns=Double(text[r]) { return ns/1e9 }
    } catch {}
    return -1
}
func safeProfile(_ path:String)->Bool {
    let u=URL(fileURLWithPath:path).resolvingSymlinksInPath().path
    return u==path && u.hasPrefix("/private/tmp/tc-web-measure/run-") &&
           URL(fileURLWithPath:u).lastPathComponent.hasPrefix("profile-")
}
func hasProfile(_ command:String,_ profile:String)->Bool {
    command.split(whereSeparator:{$0.isWhitespace}).contains(Substring("--user-data-dir="+profile))
}
func safeCapturePath(_ path:String)->Bool {
    let resolved=URL(fileURLWithPath:path).resolvingSymlinksInPath().path
    return resolved==path && path.hasSuffix(".png") &&
       (path.hasPrefix("/private/tmp/tc-web-measure/out/") || path.hasPrefix("/private/tmp/tc-web-measure/out-"))
}
let args=CommandLine.arguments
if args.contains("--gate") { emit(gateState());exit(0) }
if args.contains("--self-test") {
    assert(safeProfile("/private/tmp/tc-web-measure/run-test/profile-1"))
    assert(!safeProfile("/Users/example/Library/Application Support/Google/Chrome"))
    assert(!safeProfile("/private/tmp/tc-web-measure/run-test/../profile-1"))
    assert(hasProfile("chrome --user-data-dir=/private/tmp/tc-web-measure/run-x/profile-1", "/private/tmp/tc-web-measure/run-x/profile-1"))
    assert(!hasProfile("chrome --user-data-dir=/private/tmp/tc-web-measure/run-x/profile-10", "/private/tmp/tc-web-measure/run-x/profile-1"))
    assert(safeCapturePath("/private/tmp/tc-web-measure/out/scratch.png"))
    assert(!safeCapturePath("/private/tmp/tc-web-measure/out/../../outside.png"))
    assert(!safeCapturePath("/Users/example/Desktop/private.png"))
    emit(["selfTest":"passed","checks":8]);exit(0)
}
let profile=args.first(where:{$0.hasPrefix("--profile=")}).map{String($0.dropFirst(10))} ?? ""
if args.count>2 && args[1]=="--hide" {
    guard let target=Int32(args[2]),target>0,safeProfile(profile),hasProfile(processText(target),profile) else {emit(["error":"not the scratch pid/profile"]);exit(2)}
    emit(["ok":NSRunningApplication(processIdentifier:target)?.hide() ?? false]);exit(0)
}
if args.count>1 && ["--cover","--anchor"].contains(args[1]) {
    let g=gateState()
    guard args.count>=7,safeProfile(profile),idleSeconds()>=300,
          g["locked"] as? Bool==false,g["displayAsleep"] as? Bool==false else {exit(2)}
    class Cover:NSWindow {
        override var canBecomeKey:Bool {false}
        override var canBecomeMain:Bool {false}
    }
    let application=NSApplication.shared;application.setActivationPolicy(.accessory)
    let v=args[2...5].compactMap(Double.init);guard v.count==4 else {exit(2)}
    let height=NSScreen.screens.first?.frame.height ?? 0
    let isAnchor=args[1]=="--anchor"
    let frame=NSRect(x:v[0],y:height-v[1]-v[3],width:v[2],height:v[3])
    let window:NSWindow=isAnchor ? NSWindow(contentRect:frame,styleMask:.borderless,backing:.buffered,defer:false) : Cover(contentRect:NSRect(x:v[0],y:height-v[1]-v[3],width:v[2],height:v[3]),styleMask:.borderless,backing:.buffered,defer:false)
    window.title=isAnchor ? "Scratch focus anchor" : "Scratch inert cover";window.backgroundColor=NSColor(white:0.75,alpha:1)
    window.isOpaque=true;window.ignoresMouseEvents=true;window.hidesOnDeactivate=false
    window.level = .normal;window.orderFrontRegardless()
    if isAnchor {application.activate(ignoringOtherApps:true);window.makeKeyAndOrderFront(nil)}
    let timer=Timer.scheduledTimer(withTimeInterval:1,repeats:true) { _ in
        let g=gateState()
        if idleSeconds()<300 || g["locked"] as? Bool != false || g["displayAsleep"] as? Bool != false {
            window.orderOut(nil);exit(3)
        }
    }
    withExtendedLifetime(timer) {application.run()};exit(0)
}
guard args.count>1,let pid=Int32(args[1]),pid>=0 else {
    emit(["error":"expected pid, --gate, --self-test or --cover"]);exit(2)
}
func mayMutate()->Bool {
    let g=gateState()
    return pid>0 && safeProfile(profile) && hasProfile(processText(pid),profile) &&
        idleSeconds()>=300 && g["locked"] as? Bool==false && g["displayAsleep"] as? Bool==false
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
var refs:[AXUIElement] = [app]
var refBuckets:[CFHashCode:[Int]] = [CFHash(app):[0]]
let started=ProcessInfo.processInfo.systemUptime
func ms()->Double {(ProcessInfo.processInfo.systemUptime-started)*1000}
func rid(_ e:AXUIElement)->Int {let hash=CFHash(e);if let i=refBuckets[hash]?.first(where:{CFEqual(refs[$0],e)}) {return i};let i=refs.count;refs.append(e);refBuckets[hash,default:[]].append(i);return i}
func raw(_ e:AXUIElement,_ a:String)->(Int,CFTypeRef?) {var v:CFTypeRef?;let r=AXUIElementCopyAttributeValue(e,a as CFString,&v);return (Int(r.rawValue),v)}
func val(_ v:CFTypeRef?)->Any {guard let v=v else{return NSNull()};if CFGetTypeID(v)==AXUIElementGetTypeID(){return ["ref":rid(v as! AXUIElement)]};if CFGetTypeID(v)==AXValueGetTypeID(){let x=v as! AXValue; switch AXValueGetType(x){case .cgPoint:var p=CGPoint.zero;AXValueGetValue(x,.cgPoint,&p);return [p.x,p.y];case .cgSize:var s=CGSize.zero;AXValueGetValue(x,.cgSize,&s);return [s.width,s.height];case .cfRange:var r=CFRange();AXValueGetValue(x,.cfRange,&r);return [r.location,r.length];default:return String(describing:v)}};if let a=v as? [AnyObject]{return a.map{val($0)}};if v is String || v is NSNumber {return v};return String(describing:v)}
func attr(_ e:AXUIElement,_ a:String)->Any {let (r,v)=raw(e,a);return r==0 ? val(v) : ["error":r]}
func children(_ e:AXUIElement)->[AXUIElement] {raw(e,"AXChildren").1 as? [AXUIElement] ?? []}
func role(_ e:AXUIElement)->String {raw(e,"AXRole").1 as? String ?? ""}
let fields=["AXRole","AXSubrole","AXTitle","AXDescription","AXValue","AXSelected","AXFocused","AXLoaded","AXElementBusy","AXPosition","AXSize","AXIdentifier","AXHelp","AXURL","AXMinimized","AXVisibleCharacterRange","AXVisibleRows","AXVisibleChildren"]
func info(_ e:AXUIElement, detailed:Bool=true)->[String:Any] {var d:[String:Any]=["id":rid(e)];for a in fields {d[a]=attr(e,a)};var an:CFArray?;d["actionsError"]=AXUIElementCopyActionNames(e,&an).rawValue;d["actions"]=an as? [String] ?? [];if detailed{var names:CFArray?;d["attributesError"]=AXUIElementCopyAttributeNames(e,&names).rawValue;d["attributes"]=names as? [String] ?? [];var s:[String:Any]=[:];for a in ["AXValue","AXSelected","AXFocused","AXSelectedText"]{var b=DarwinBoolean(false);let err=AXUIElementIsAttributeSettable(e,a as CFString,&b);s[a]=["error":err.rawValue,"settable":b.boolValue]};d["settable"]=s};d["childCount"]=children(e).count;return d}
func snapshot(_ root:AXUIElement,_ cap:Int)->[String:Any]{var nodes:[[String:Any]]=[];var seen=Set<Int>();func walk(_ e:AXUIElement,_ parent:Int?,_ depth:Int){let id=rid(e);guard nodes.count<cap,depth<80,!seen.contains(id) else{return};seen.insert(id);var d=info(e,detailed:!["AXStaticText","AXCell","AXRow"].contains(role(e)));d["parent"]=parent ?? -1;d["depth"]=depth;nodes.append(d);for c in children(e){walk(c,id,depth+1)}};walk(root,nil,0);return ["nodes":nodes,"capped":nodes.count>=cap]}
func windows()->[[String:Any]] {let a=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? [];return a.enumerated().filter{($0.element[kCGWindowOwnerPID as String] as? Int)==Int(pid)}.map{index,w in ["order":index,"id":w[kCGWindowNumber as String] ?? 0,"bounds":w[kCGWindowBounds as String] ?? [:],"onscreen":w[kCGWindowIsOnscreen as String] ?? false,"layer":w[kCGWindowLayer as String] ?? 0,"title":w[kCGWindowName as String] ?? ""]}}
var notes:[[String:Any]]=[]
var observer:AXObserver?
let cb:AXObserverCallback = {_,e,n,_ in notes.append(["ms":ms(),"name":n as String,"id":rid(e),"role":role(e)])}
func subscribe(_ e:AXUIElement)->[String:Int32]{if observer==nil{var o:AXObserver?;let err=AXObserverCreate(pid,cb,&o);if err != .success{return ["create":err.rawValue]};observer=o;CFRunLoopAddSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(o!),.defaultMode)};var r:[String:Int32]=[:];for n in ["AXLoadComplete","AXElementBusyChanged","AXLayoutChanged","AXValueChanged","AXCreated"]{r[n]=AXObserverAddNotification(observer!,e,n as CFString,nil).rawValue};return r}
func focus()->[String:Any]{let (err,v)=raw(app,"AXFocusedUIElement");guard err==0,let v=v else{return ["error":err]};var e=v as! AXUIElement;var chain:[[String:Any]]=[];var inside=false;for _ in 0..<50{chain.append(info(e,detailed:false));if role(e)=="AXWebArea"{inside=true};guard let p=raw(e,"AXParent").1,CFGetTypeID(p)==AXUIElementGetTypeID() else{break};let parent=p as! AXUIElement;if CFEqual(e,parent){break};e=parent};return ["chain":chain,"insideWebArea":inside]}

while let line=readLine(){CFRunLoopRunInMode(.defaultMode,0.001,false);do{guard let c=try JSONSerialization.jsonObject(with:Data(line.utf8)) as? [String:Any] else {emit(["error":"command must be an object"]);continue};let op=c["op"] as? String ?? "";let t=ms();let id=c["id"] as? Int ?? 0;guard refs.indices.contains(id) else {emit(["error":"invalid element id"]);continue};let e=refs[id]
let mutations:Set<String>=["setPoint","setSize","set","action","key","click","scroll"]
if mutations.contains(op) && !mayMutate() {emit(["error":"mutation denied: need scratch pid/profile, unlocked awake Mac and 300 seconds idle"]);continue}
if ["attr","set","setPoint"].contains(op) && c["attr"] as? String==nil {emit(["error":"attr must be a string"]);continue}
if op=="action" && c["action"] as? String==nil {emit(["error":"action must be a string"]);continue}
if op=="set" && c["value"]==nil {emit(["error":"value is required"]);continue}
if op=="setPoint" && (c["x"] as? Double==nil || c["y"] as? Double==nil) {emit(["error":"x and y must be numbers"]);continue}
if op=="setSize" && (c["w"] as? Double==nil || c["h"] as? Double==nil) {emit(["error":"w and h must be numbers"]);continue}
var out:[String:Any]=[:];switch op{
case "gate":let s=CGSessionCopyCurrentDictionary() as? [String:Any] ?? [:];out=["locked":s["CGSSessionScreenIsLocked"] ?? false,"onConsole":s["kCGSSessionOnConsoleKey"] ?? false,"displayAsleep":CGDisplayIsAsleep(CGMainDisplayID()) != 0,"displayBounds":[CGDisplayBounds(CGMainDisplayID()).width,CGDisplayBounds(CGMainDisplayID()).height]]
case "snapshot":out=snapshot(e,c["cap"] as? Int ?? 15000)
case "sample":
 var areas:[[String:Any]]=[];var tabs:[[String:Any]]=[];var seen=Set<Int>();var count=0
 func walk(_ x:AXUIElement,_ depth:Int){let i=rid(x);guard count<15000,depth<60,!seen.contains(i) else{return};seen.insert(i);count+=1;let r=role(x);if r=="AXWebArea"{areas.append(info(x,detailed:false));return};if r=="AXTabButton" || raw(x,"AXSubrole").1 as? String=="AXTabButton"{tabs.append(info(x,detailed:false))};for ch in children(x){walk(ch,depth+1)}}
 walk(e,0);out=["areas":areas,"tabs":tabs,"visited":count,"appManual":attr(app,"AXManualAccessibility"),"appEnhanced":attr(app,"AXEnhancedUserInterface")]
case "rows":
 let rr=(raw(e,"AXRows").1 as? [AXUIElement]) ?? children(e).filter{role($0)=="AXRow"};var result:[[String:Any]]=[]
 for row in rr{var texts:[String]=[];var seen=Set<Int>();func textsAt(_ x:AXUIElement,_ depth:Int){let i=rid(x);guard depth<10,!seen.contains(i) else{return};seen.insert(i);for a in ["AXValue","AXTitle","AXDescription"]{if let s=raw(x,a).1 as? String,!s.isEmpty{texts.append(s)}};for c in children(x){textsAt(c,depth+1)}};textsAt(row,0);result.append(["id":rid(row),"position":attr(row,"AXPosition"),"size":attr(row,"AXSize"),"texts":texts])};out=["rows":result,"count":rr.count]
case "capture":
 guard CGPreflightScreenCaptureAccess() else {emit(["error":"screen capture permission absent; no prompt requested"]);continue}
 let candidates=windows().filter { w in
     guard let b=w["bounds"] as? [String:Any] else{return false}
     return w["layer"] as? Int==0 && (b["Width"] as? Double ?? 0)>200 && (b["Height"] as? Double ?? 0)>200
 }
 guard let w=candidates.first,let wid=w["id"] as? UInt32,
       let handle=dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",RTLD_LAZY),
       let symbol=dlsym(handle,"CGWindowListCreateImage") else {emit(["error":"window capture API or scratch content window unavailable"]);continue}
 defer {dlclose(handle)}
 typealias Capture = @convention(c) (CGRect,UInt32,UInt32,UInt32)->Unmanaged<CGImage>?
 let capture=unsafeBitCast(symbol,to:Capture.self)
 guard let image=capture(.null,8,wid,1)?.takeRetainedValue() else {emit(["error":"CGWindowListCreateImage returned nil"]);continue}
 guard let path=c["path"] as? String,safeCapturePath(path) else {emit(["error":"capture path must be scratch PNG"]);continue}
 let rep=NSBitmapImageRep(cgImage:image)
 guard let data=rep.representation(using:.png,properties:[:]) else {emit(["error":"PNG encoding failed"]);continue}
 try data.write(to:URL(fileURLWithPath:path))
 let b=w["bounds"] as! [String:Any];let width=(b["Width"] as? Double ?? 1),height=(b["Height"] as? Double ?? 1)
 let region=c["region"] as? [Double] ?? [0,143,width,max(0,height-143)]
 guard region.count==4 else {emit(["error":"region needs x y width height"]);continue}
 let sx=Double(image.width)/width,sy=Double(image.height)/height
 let rect=CGRect(x:region[0]*sx,y:region[1]*sy,width:region[2]*sx,height:region[3]*sy).intersection(CGRect(x:0,y:0,width:image.width,height:image.height))
 guard !rect.isNull,rect.width>0,rect.height>0,let body=image.cropping(to:rect) else {emit(["error":"body crop outside window","file":path]);continue}
 let bw=body.width,bh=body.height;var bytes=[UInt8](repeating:0,count:bw*bh*4)
 let white=bytes.withUnsafeMutableBytes { storage -> Int in
     guard let context=CGContext(data:storage.baseAddress,width:bw,height:bh,bitsPerComponent:8,bytesPerRow:bw*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{return -1}
     context.draw(body,in:CGRect(x:0,y:0,width:bw,height:bh))
     let pixels=storage.bindMemory(to:UInt8.self);var count=0
     for i in stride(from:0,to:pixels.count,by:4) {if pixels[i]>=250 && pixels[i+1]>=250 && pixels[i+2]>=250 && pixels[i+3]>=250 {count+=1}}
     return count
 }
 out=["api":"CGWindowListCreateImage","file":path,"window":w,"bodyRegion":region,"estimatedRegion":c["region"]==nil,"width":image.width,"height":image.height,"bodyWhiteFraction":Double(white)/Double(bw*bh),"bodyAllWhite":white==bw*bh]
case "setPoint":
 var p=CGPoint(x:c["x"] as! Double,y:c["y"] as! Double);out=["error":AXUIElementSetAttributeValue(e,(c["attr"] as! String) as CFString,AXValueCreate(.cgPoint,&p)!).rawValue]
case "setSize":
 var z=CGSize(width:c["w"] as! Double,height:c["h"] as! Double);out=["error":AXUIElementSetAttributeValue(e,"AXSize" as CFString,AXValueCreate(.cgSize,&z)!).rawValue]
case "info":out=info(e)
case "attr":out=["value":attr(e,c["attr"] as! String)]
case "set":let a=c["attr"] as! String;let v=c["value"]!;out=["error":AXUIElementSetAttributeValue(e,a as CFString,v as CFTypeRef).rawValue,"readback":attr(e,a)]
case "action":out=["error":AXUIElementPerformAction(e,(c["action"] as! String) as CFString).rawValue]
case "focus":out=focus()
case "inventory":
 let ws=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
 out=["windows":ws.enumerated().map{i,w in ["order":i,"pid":w[kCGWindowOwnerPID as String] ?? 0,"id":w[kCGWindowNumber as String] ?? 0,"bounds":w[kCGWindowBounds as String] ?? [:],"layer":w[kCGWindowLayer as String] ?? 0]},"frontPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
case "status":out=["active":NSRunningApplication(processIdentifier:pid)?.isActive ?? false,"frontPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"frontBundle":NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "","windows":windows()]
case "hide":
 guard safeProfile(profile),hasProfile(processText(pid),profile) else {emit(["error":"not the scratch pid/profile"]);continue}
 out=["ok":NSRunningApplication(processIdentifier:pid)?.hide() ?? false]
case "key":let code=CGKeyCode(c["code"] as? Int ?? 0);for down in [true,false]{let ev=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down)!;if let text=c["text"] as? String{let u=Array(text.utf16);ev.keyboardSetUnicodeString(stringLength:u.count,unicodeString:u)};ev.flags=CGEventFlags(rawValue:UInt64(c["flags"] as? Int ?? 0));ev.postToPid(pid)};out=["posted":true]
case "subscribe":out=["results":subscribe(e)]
case "poll":CFRunLoopRunInMode(.defaultMode,Double(c["seconds"] as? Double ?? 0.02),false);out=["notes":notes];notes=[]
case "quit":exit(0)
default:out=["error":"unknown op"]};out["ms"]=ms()-t;out["atMs"]=ms();emit(out)}catch{emit(["error":String(describing:error)])}}
