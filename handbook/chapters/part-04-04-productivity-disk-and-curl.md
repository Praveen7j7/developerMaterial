## 4.8 Working faster in the shell

### 4.8.1 Tab completion, history, shortcuts and editing files

#### Concept

Most of the time you spend in a terminal is not thinking, it is typing. A handful of shell features cut that typing by more than half: **Tab completion** finishes file names and commands for you, **history** lets you find and rerun earlier commands, a few **keyboard shortcuts** move and edit the current line, **aliases** give long commands short names, and a simple terminal **editor** (`nano`) lets you change a config file on a server that has no graphical editor.

#### Why does it exist?

Because commands on a server are long and precise. `tail -f /var/log/myapp/application-2026-11-05.log` is 52 characters, and one typo means "No such file or directory". Typing it from scratch ten times during an incident is slow and error-prone. The shell remembers everything you typed and knows every file name in the directory, so it can do most of the typing for you, correctly.

#### Mental model

Imagine a very attentive assistant standing behind you. You start saying a file name and they finish it. You say "that command I ran an hour ago with `docker` in it" and they hand it back to you. You never have to spell a long path twice.

#### How it works

**Tab completion.** Type the start of a command, file or directory and press Tab. If only one thing matches, the shell completes it. If several match, press Tab twice to see them all.

```bash
cd /var/lo<Tab>          # becomes: cd /var/log/
tail -f app<Tab>         # becomes: tail -f application.log (if it is the only match)
ls src/mo<Tab><Tab>      # shows: modules/  models/   (two matches; type one more letter)
```

If Tab does nothing, there is no match: the file is not where you think it is. That is useful information on its own.

**History.**

```bash
history                  # numbered list of your recent commands
history | grep docker    # find old commands that mention docker
!42                      # rerun command number 42 from the list
!!                       # rerun the last command
sudo !!                  # rerun the last command with sudo (when you forgot it)
```

Press the Up arrow to step back through previous commands one at a time. Press **Ctrl+R** and type any part of an old command to search history backwards; press Ctrl+R again to go further back, Enter to run, or the Right arrow to edit it first.

**Line-editing shortcuts** (bash and zsh, default settings):

| Keys | Action |
|---|---|
| Ctrl+A / Ctrl+E | Jump to start / end of the line |
| Ctrl+W | Delete the word before the cursor |
| Ctrl+U | Delete from the cursor to the start of the line |
| Ctrl+C | Cancel the current command (or stop a running program) |
| Ctrl+L | Clear the screen (same as `clear`) |
| Ctrl+D | End of input; on an empty prompt, logs you out of the shell |
| Alt+. (or Esc then .) | Insert the last argument of the previous command |

**Aliases** are short names for long commands. They live in your shell's start-up file: `~/.bashrc` for bash, `~/.zshrc` for zsh (macOS uses zsh by default).

```bash
alias ll='ls -lah'                       # long listing, hidden files, human sizes
alias gs='git status'
alias logs='tail -f /var/log/myapp/application.log'
source ~/.bashrc                         # reload the file so new aliases work now
type ll                                  # shows: ll is aliased to 'ls -lah'
```

**Editing files with `nano`.** Servers rarely have a graphical editor. `nano` is the friendliest terminal editor and is installed almost everywhere.

```bash
nano /etc/myapp/config.env               # open (or create) the file
# Type to edit. The bottom two lines list the commands; ^ means Ctrl.
# Ctrl+O then Enter: save ("write Out")     Ctrl+X: exit
# Ctrl+W: search                            Ctrl+K: cut a whole line, Ctrl+U: paste it
```

You will also meet `vim`, which is powerful and everywhere but confusing at first. If you open it by accident (Git sometimes does), press Esc, then type `:q!` and Enter to quit without saving, or `:wq` and Enter to save and quit.

#### Practical example — the same task, slow and fast

Task: look at the last 50 lines of today's log, then follow it live, then find errors in it.

Slow (typed in full three times, 150 characters, two typos):

```bash
tail -n 50 /var/log/myapp/application-2026-11-05.log
tail -f /var/log/myapp/application-2026-11-05.log
grep ERROR /var/log/myapp/application-2026-11-05.log
```

Fast (about 40 keystrokes):

```bash
tail -n 50 /var/log/myapp/app<Tab>       # Tab completes the long name once
tail -f <Alt+.>                          # Alt+. inserts the same path again
grep ERROR <Alt+.>                       # and again
```

#### Practical example — fixing a config value on a server

The API on a staging server is logging too much. You need to change `LOG_LEVEL=debug` to `LOG_LEVEL=info` in `/etc/myapp/config.env` and restart.

```bash
sudo cp /etc/myapp/config.env /etc/myapp/config.env.bak   # 1. back up before editing
sudo nano /etc/myapp/config.env                           # 2. Ctrl+W, type LOG_LEVEL, Enter, edit, Ctrl+O, Enter, Ctrl+X
grep LOG_LEVEL /etc/myapp/config.env                      # 3. check: LOG_LEVEL=info
sudo systemctl restart myapp                              # 4. restart so the app reads the new value
```

The backup in step 1 takes one second and lets you undo the change with `sudo cp config.env.bak config.env` if you break something.

#### Edge cases & failure modes

- **Secrets in history.** `export DB_PASSWORD=hunter2` typed at the prompt is saved in `~/.bash_history`. In bash, starting a command with a space keeps it out of history when `HISTCONTROL` includes `ignorespace` (the default on many distributions); better, never type secrets on the command line at all.
- **`!!` and `!42` run immediately** without showing you the command first; with `sudo`, check `history` before you use them.
- **Aliases hide what really runs.** `rm` aliased to `rm -i` on your laptop teaches you to rely on a prompt that does not exist on the server.
- **Editing with `sudo nano`** creates the file owned by root if it did not exist; check owner and permissions afterwards (4.2).
- **Windows line endings**: a file edited on Windows and copied to Linux can contain `\r` characters that break shell scripts with confusing errors like `$'\r': command not found`.

#### How a Senior Backend Engineer thinks about this

A senior is fast in the shell because they almost never type a full path: Tab, Ctrl+R and Alt+. do it for them. Speed matters less than correctness, though: completion stops typos, and searching history reuses a command that already worked. They keep personal aliases on their laptop, but on a shared server they type the real commands, so they never depend on a shortcut that is not there. And before editing any file on a server, they make a copy, because "I will remember what it said" is not a backup.

#### Common mistakes

- Typing long paths by hand and making typos.
- Pressing Up fifty times instead of using Ctrl+R.
- Typing passwords and tokens directly into commands, where history keeps them.
- Editing a production config without a backup.
- Getting stuck in `vim` and closing the whole terminal to escape.

#### Interview questions

1. **How do you rerun a command you ran an hour ago without retyping it?** Ctrl+R and type part of it, or `history | grep word` then `!number`.
2. **Why should you not type a password as part of a command?** It is saved in shell history and may be visible to other users in the process list (`ps`).
3. **Where do aliases live, and how do you make a new one take effect?** In `~/.bashrc` or `~/.zshrc`; run `source` on the file or open a new shell.

#### Practical exercise

On your machine: create the alias `ll` for `ls -lah` in your shell start-up file and reload it; use Ctrl+R to find the last `cd` command you ran; create a file `~/practice/app.env` with `nano` containing `PORT=3000` and `LOG_LEVEL=debug`, then change the log level to `info`, save and exit. Acceptance criteria: `type ll` shows your alias, `grep LOG_LEVEL ~/practice/app.env` prints `LOG_LEVEL=info`, and you can name the three `nano` shortcuts you used.

## 4.9 Is the server healthy? Disk, memory and load

### 4.9.1 Checking disk space, memory and CPU in a minute

#### Concept

Many backend outages are not bugs in your code. The disk is full, so the database cannot write and the app cannot log. Memory is exhausted, so Linux kills your process. The CPU is saturated, so every request is slow. Four commands answer "is the machine itself healthy?" in under a minute: `df` (disk free), `du` (disk usage of folders), `free` (memory), and `uptime` or `top` (load and CPU).

#### Why does it exist?

Because a full disk and a slow bug look the same from the outside: requests fail. If you only look at your code, you can lose an hour before checking the machine. Checking the machine first takes one minute and rules out (or finds) the most common non-code causes.

#### Mental model

Imagine a delivery van that stopped working. Before you open the engine, you check the fuel gauge, the oil light and the tyres. It takes a minute, and it is embarrassing to spend an hour on the engine when the tank was empty. `df`, `free` and `uptime` are the gauges.

#### How it works

**Disk space, whole filesystems:**

```bash
$ df -h                                   # -h: human-readable sizes (G, M)
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p1   30G   29G  1.0G  97% /
/dev/nvme1n1    200G   88G  112G  44% /var/lib/postgresql
tmpfs           3.9G     0  3.9G   0% /dev/shm
```

Read the `Use%` column. Above about 90 % is a warning; at 100 % things start failing. Here the root filesystem (`/`) is at 97 %: logs, temporary files and anything under `/` except the database disk will soon fail to write.

**Which folders use the space:**

```bash
$ sudo du -sh /var/log/* | sort -h | tail -n 5     # -s: one total per item, sort -h: sort human sizes
120M  /var/log/journal
310M  /var/log/nginx
1.2G  /var/log/syslog.1
18G   /var/log/myapp
```

`du` walks folders and adds up file sizes. Start at a high level (`du -sh /*`), find the biggest folder, then go one level deeper, until you find the culprit. Here `/var/log/myapp` holds 18 GB.

**Memory:**

```bash
$ free -h
               total        used        free      shared  buff/cache   available
Mem:           7.7Gi       6.9Gi       210Mi        12Mi       610Mi       520Mi
Swap:             0B          0B          0B
```

Read the `available` column, not `free`. Linux uses spare memory as a disk cache (`buff/cache`) and gives it back when programs need it, so a small `free` number is normal. A small `available` number (here 520 MB of 7.7 GB) means programs are about to run out, and the kernel's out-of-memory killer may stop your app (4.3).

**Load and CPU:**

```bash
$ uptime
 14:02:11 up 41 days,  3:12,  1 user,  load average: 7.85, 7.10, 4.02
$ nproc
2
```

The **load average** is roughly how many processes were running or waiting to run, averaged over the last 1, 5 and 15 minutes. Compare it with the number of CPU cores (`nproc`). A load of 7.85 on 2 cores means work is queueing: about four times more demand than the CPUs can serve. Then `top` (4.3) shows which process is using the CPU.

**Which program is it, and where does it live?**

```bash
which node            # /usr/bin/node: the program that runs when you type node
node --version        # v20.11.1: is it the version you expected?
```

#### Practical example — the disk-full incident

At 09:40 the API starts returning `500` errors for every order. The logs stop updating. Here is the one-minute check that finds it:

```bash
df -h /                                         # 1. Use% 100%: the disk is full
sudo du -sh /var/log/* | sort -h | tail -n 3    # 2. /var/log/myapp is 26G
ls -lh /var/log/myapp | tail -n 3               # 3. one file, debug.log, 25G, still growing
```

Someone deployed with `LOG_LEVEL=debug` last night, and the app wrote every SQL query to a log file with no rotation. The fix, in order:

```bash
sudo truncate -s 0 /var/log/myapp/debug.log     # 4. empty the file in place (safe while the app has it open)
df -h /                                         # 5. Use% 18%: space is back, writes succeed again
sudo nano /etc/myapp/config.env                 # 6. set LOG_LEVEL=info, then restart the app (72.8)
```

Why `truncate` and not `rm`? If you delete a file that a running program still has open, the program keeps writing to it and the space is **not** freed until the program closes it: `df` still shows 100 %. Emptying the file in place frees the space immediately. The lasting fix is log rotation (the `logrotate` tool, or logging to stdout and letting the platform handle it, Part 77.2) and a disk-space alert at 80 %.

#### Practical example — the "slow server" check

Users report the admin site is slow. Before reading any code:

```bash
uptime                       # load average 0.40 on 2 cores: CPU is fine
free -h                      # available 3.1Gi of 7.7Gi: memory is fine
df -h                        # all under 60 %: disk is fine
```

All three gauges are normal, so the machine is not the problem. The next step is the app and its dependencies: its logs (4.1), the database (Part 6 shows `psql`), or a slow external API. One minute spent, one whole class of causes ruled out.

#### Edge cases & failure modes

- **Deleting an open log file** does not free space until the process closes it; use `truncate -s 0` or restart the process.
- **Inodes can run out** before bytes do: millions of tiny files (session files, cache entries) fill the filesystem's file table. `df -i` shows inode usage; "No space left on device" with free bytes means this.
- **Containers** have their own view: inside a container, `free` may show the host's memory, not the container's limit (Part 86.10 explains limits).
- **`du` on a huge directory** can take minutes and add disk load; start high and narrow down instead of running it on `/` with no `-s`.
- **Load average is not CPU percent**: processes waiting for slow disk also count, so a high load with idle CPUs points to disk or network waits.

#### How a Senior Backend Engineer thinks about this

A senior checks the gauges before the engine. When something breaks they spend the first minute on `df -h`, `free -h` and `uptime`, because those rule out the cheapest causes. They know how to read each one correctly (`available` not `free`, load compared with cores, `Use%` per filesystem) and they know the traps (deleted-but-open files, inodes). Most of all, they turn every incident like this into an alert, so next time the disk warns them at 80 % instead of failing at 100 %.

#### Common mistakes

- Deleting a big log file and wondering why the disk is still full.
- Reading `free` instead of `available` and panicking about normal cache use.
- Ignoring the number of cores when reading the load average.
- Fixing the full disk but not the cause (log level, missing rotation, no alert).

#### Interview questions

1. **The API is failing and logs stopped. What is the first thing you check on the server?** Disk space with `df -h`; a full disk stops log writes and database writes.
2. **You deleted a 20 GB log file but `df` still shows the disk full. Why?** A running process still has the file open, so the space is not released; truncate the file or restart the process.
3. **How do you read a load average of 6 on a 2-core machine?** About three times more runnable work than cores: requests are waiting; check `top` for the cause.
4. **Why is a small `free` memory number usually fine?** Linux uses spare memory for disk cache and releases it on demand; `available` is the number that matters.

#### Practical exercise

On your machine (or a small cloud server), find: the `Use%` of the filesystem your home directory is on, the three largest folders inside your home directory, the `available` memory, and the 1-minute load average compared with `nproc`. Then create a 200 MB test file with `fallocate -l 200M ~/practice/big.bin` (Linux) or `mkfile 200m ~/practice/big.bin` (macOS), see it in `du -sh ~/practice`, and delete it. Acceptance criteria: you write down all four numbers and explain in one sentence each whether that number would worry you on a production server.

## 4.10 Talking to your API from the terminal

### 4.10.1 curl, jq and "who is using port 3000?"

#### Concept

`curl` sends HTTP requests from the command line. It is the fastest way to check whether an API answers, what status code it returns, which headers it sends, and what the body looks like, on your laptop or on a server with no browser. `jq` reads JSON and pretty-prints or filters it, so a long API response becomes readable. And `lsof` or `ss` tell you which program is listening on a port, which you need the first time you see "address already in use".

#### Why does it exist?

Because a browser hides too much and a server has no browser. A browser follows redirects, sends cookies, caches responses and shows a pretty page; when an endpoint misbehaves, you want the raw request and the raw response. Part 3 explained HTTP requests, status codes and headers; `curl` lets you see them for real in one line.

#### Mental model

Imagine talking to a shop through a hatch in the wall instead of walking in. You pass a written order through (the request), and you get back exactly what they hand you (status, headers, body), with no shop assistant interpreting it for you. `curl` is the hatch. `jq` is a magnifying glass for the paperwork that comes back.

#### How it works

```bash
curl http://localhost:3000/health                       # GET; prints the body
curl -i http://localhost:3000/health                    # -i: include status line and headers
curl -s http://localhost:3000/products | jq             # -s: silent (no progress bar); jq pretty-prints
curl -s http://localhost:3000/products | jq '.[0].name'  # just the first product's name
curl -s http://localhost:3000/products | jq 'length'     # how many items

# POST with a JSON body
curl -i -X POST http://localhost:3000/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sonic toothbrush","priceCents":129900}'

# Only the status code, and how long the request took
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' http://localhost:3000/products
```

Useful options: `-X METHOD`, `-H 'Header: value'` (repeatable), `-d 'body'` (sends a POST body), `-L` (follow redirects), `-v` (verbose: shows the request headers too, and the TLS handshake for `https`), `--max-time 5` (give up after 5 seconds).

The backslash `\` at the end of a line continues the command on the next line, which keeps long commands readable.

**Which program is on a port:**

```bash
lsof -i :3000                       # macOS and Linux: list processes using port 3000
sudo ss -ltnp | grep 3000           # Linux: listening TCP sockets with the owning process
# LISTEN 0 511 *:3000 *:* users:(("node",pid=4821,fd=23))
```

#### Practical example — "the frontend says the API is broken"

A teammate says the product page shows nothing. Three `curl` commands narrow it down in a minute:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health
# 200: the API process is up and answering

curl -i http://localhost:3000/products
# HTTP/1.1 500 Internal Server Error
# content-type: application/json; charset=utf-8
# {"statusCode":500,"message":"Internal server error"}

tail -n 20 /var/log/myapp/application.log | grep -i error
# ERROR [ExceptionsHandler] relation "products" does not exist
```

The API is up, the products endpoint fails, and the log says the database table is missing: the migration did not run (Part 6 shows migrations). The frontend was never the problem.

#### Practical example — "address already in use"

```bash
$ npm run start:dev
Error: listen EADDRINUSE: address already in use :::3000

$ lsof -i :3000
COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF NODE NAME
node    4821 alice  23u IPv6  0x...       0t0  TCP *:3000 (LISTEN)

$ ps -p 4821 -o pid,etime,command          # what is it, and since when?
  PID  ELAPSED COMMAND
 4821  2-03:11 node dist/main.js            # an old copy of your API, running for 2 days

$ kill 4821                                 # SIGTERM: ask it to stop (72.3)
$ npm run start:dev                         # now it starts
```

The old process was a copy started in another terminal two days ago and forgotten. Always find out what the process is before you kill it: on a shared server, PID 4821 might be someone else's service.

#### Edge cases & failure modes

- **Quotes in JSON bodies**: use single quotes around the JSON so the shell does not touch the double quotes inside it.
- **`curl` does not fail on HTTP errors** by default: a `500` response still exits with code 0. In scripts, add `--fail` (or `-f`) so `curl` exits non-zero on `4xx` and `5xx`.
- **Self-signed certificates**: `curl -k` skips certificate checks; fine on a local test server, never as a habit against real servers.
- **Secrets on the command line**: `curl -H 'Authorization: Bearer eyJ...'` lands in shell history; read the token from an environment variable instead: `-H "Authorization: Bearer $TOKEN"` (double quotes, so the shell expands the variable).
- **`jq` errors on non-JSON**: an HTML error page from a proxy makes `jq` fail with "parse error"; look at it with `curl -i` first.
- **`localhost` inside a container** is the container itself, not your laptop (Part 86.7).

#### How a Senior Backend Engineer thinks about this

A senior reaches for `curl -i` before opening a browser, because it shows exactly what the API sent: status, headers and body, with nothing hidden. They check health first, then the failing endpoint, then the log, which turns "the app is broken" into one specific failing line in about a minute. They keep tokens in variables, add `--fail` and `--max-time` in scripts, and never kill a process on a port until they know what it is.

#### Common mistakes

- Testing APIs only through the browser and missing headers and status codes.
- Pasting tokens directly into `curl` commands.
- Forgetting `-H 'Content-Type: application/json'` on a POST, then wondering why the API sees an empty body.
- `kill -9` on whatever holds the port, without checking what it is.

#### Interview questions

1. **How do you see the status code and headers of an API response from the terminal?** `curl -i URL` (or `-v` to see the request too).
2. **How do you find which process is using port 3000?** `lsof -i :3000`, or `ss -ltnp` on Linux, then `ps -p PID` to see what it is.
3. **Why add `--fail` to `curl` in a script?** Without it, `curl` exits successfully even for `4xx` and `5xx` responses, so the script cannot tell the request failed.

#### Practical exercise

Start any local HTTP server (for example the API from Part 6, or `npx http-server` in a folder). Using only the terminal: get the status code of `/` with the `-w` option, print the response headers, send a POST with a JSON body, and pretty-print a JSON response with `jq`. Then start the same server a second time to get "address already in use", find the first one with `lsof -i`, identify it with `ps`, and stop it with `kill`. Acceptance criteria: you can show each command and its output, and explain what `-s`, `-i`, `-o /dev/null` and `-w` each did.
