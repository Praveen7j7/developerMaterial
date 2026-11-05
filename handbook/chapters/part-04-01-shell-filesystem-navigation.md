# Part 4 — Linux and the Command Line

Your code runs on Linux. Not on your laptop's friendly desktop, but on a Linux server in a data center, inside a container, reached over a text-only connection. When your backend misbehaves at 2 a.m., you will not click buttons to fix it; you will type commands into a terminal. The command line is where backend engineers actually live, and fluency in it is the difference between an engineer who can only write code and one who can run, inspect and repair a production system.

This Part teaches the Linux command line from the beginning, aimed squarely at what a backend developer needs: the shell and the filesystem, navigation, permissions, processes, pipes and redirection, environment variables, package managers, and the SSH basics for reaching a remote server. We do not cover system administration in depth; we cover the commands you will reach for every day and the mental models that make them stick. Part 9 covers processes, threads and signals at the operating-system level; this Part is the practical, hands-on layer.

A note on terms. "The shell" is the program that reads your commands and runs them — on most systems that is `bash` or `zsh`. "The terminal" is the window the shell runs in. "The command line" is the general idea of typing commands. We use them loosely, as everyone does.

## 4.1 The shell and the filesystem

### 4.1.1 What the shell is

#### Concept

The shell is a program that waits for you to type a command, runs it, shows the output, and waits again. It is a text-based way to tell the computer to do things: list files, run programs, start your server, read logs. Every command follows the same shape — the name of a program, then options and arguments — and learning the shell is mostly learning that shape and a few dozen programs.

#### Why does it exist?

A graphical interface shows you a fixed set of buttons someone decided to build. A shell lets you run any program, combine programs, repeat commands, automate them in scripts, and do all of it over a text-only remote connection to a server that has no screen. Servers have no desktop; the shell is the only interface they offer. It is also faster for an expert: typing `grep error app.log` finds every error line instantly, with no mouse, no scrolling.

#### Mental model

The shell is a conversation with the computer in a tiny, precise language. You say a sentence (a command), it does the thing and replies. The "words" are programs; the "grammar" is options and arguments and the pipes that join commands together. Like any language, the first hundred words feel awkward and then become automatic. Unlike a human language, it is unforgiving: a space in the wrong place or a wrong character changes the meaning completely, so precision matters.

#### How it works

A command has three parts:

```bash
command   -options   arguments
ls        -l         /var/log
```

- The **command** is the program to run (`ls`, the "list" program).
- **Options** (also called flags) modify behavior, usually starting with `-` (`-l` means "long format"). Short options can combine: `-la` is `-l -a`. Long options use `--` (`--all`).
- **Arguments** are what the command acts on (`/var/log`, a directory to list).

The shell prints a **prompt** (often ending in `$`) and waits. You type a command, press Enter, it runs, output appears, and you get a new prompt. The prompt usually shows your username, the machine, and the current directory, so you always know where you are and who you are.

```bash
alice@web-prod-1:/var/www/app$ ls -l
# ^user  ^machine    ^current directory  ^the command you typed
```

#### Getting help

Three ways to learn any command, which you will use constantly:

```bash
man ls            # the full manual page (press q to quit, / to search)
ls --help         # a shorter usage summary
tldr ls           # community examples, if the 'tldr' tool is installed
```

When you do not know a command, `man` is the answer. Nobody memorizes every option; they look them up.

#### Practical example

A first session a backend developer might run on logging into a server:

```bash
whoami            # which user am I? -> alice
hostname          # which machine am I on? -> web-prod-1
pwd               # where am I? -> /home/alice
date              # what time does the server think it is? (time zones matter)
uptime            # how long has the server been up, and how loaded is it?
```

Each is one word, each answers one question. This is the texture of command-line work: small precise questions, immediate answers.

#### How a Senior Backend Engineer thinks about this

A senior is fluent enough in the shell that it disappears — they think about the problem, not the typing. They always know three things before acting on a server: who they are (`whoami`), where they are (`pwd`), and which machine they are on (`hostname`), because running the right command on the wrong server or as the wrong user is how accidents happen. They reach for `man` and `--help` without shame, because the mark of expertise is knowing what to look up, not memorizing everything. They treat the production shell with respect: a command that would be harmless on a laptop can be an incident on a production server.

#### Common mistakes

- Running a command on the wrong server because you did not check `hostname`.
- Running as `root` (the all-powerful user) when a normal user would do, so a typo becomes a disaster.
- Not reading `man`/`--help` and guessing at options.
- Copy-pasting commands from the internet without understanding them (especially destructive ones).

#### Interview questions

1. **What is the difference between the shell, the terminal and the command line?** The shell is the program interpreting commands (bash/zsh); the terminal is the window it runs in; the command line is the general concept. (Beginner-level; the point is clarity of terms.)
2. **How do you find out what a command does and its options?** `man command`, `command --help`, or `tldr command`.
3. **Why always check who and where you are before acting on a server?** Running the right command on the wrong host or as the wrong user turns a routine action into an incident.

#### Practical exercise

Open a terminal and, using only the commands above, answer: your username, your machine's hostname, your current directory, the current server time, and how long the machine has been up. Then open the manual page for `ls`, find what the `-h` option does, and quit the manual. Acceptance criteria: you can state what `ls -lh` would show differently from `ls -l`.

### 4.1.2 The filesystem and navigating it

#### Concept

Linux organizes everything into a single tree of directories (folders) starting from the root, written `/`. Every file and directory has a path describing where it sits in that tree. Navigating the filesystem — knowing where you are, moving around, and listing what is there — is the most basic command-line skill and the foundation of everything else.

#### Why does it exist?

Your code, its configuration, its logs, and the system's own files all live somewhere in the filesystem. To run your server you must be in or point to the right directory; to read logs you must find the log directory; to fix a config you must locate the config file. The filesystem is the map, and paths are the addresses.

#### Mental model

The filesystem is a tree, or like a set of nested folders. The root `/` is the trunk. Branches lead to directories like `/home` (users' files), `/var` (variable data like logs), `/etc` (configuration), `/usr` (installed programs). Your current position in this tree is the "working directory", like standing in one room of a large building. A path is directions to a room: either from the entrance (an absolute path starting with `/`) or from where you are standing (a relative path).

#### How it works

```text
/                          the root of everything
├── home/
│   └── alice/             your home directory, shortcut: ~
│       └── app/
│           ├── src/
│           └── package.json
├── etc/                   system configuration files
├── var/
│   └── log/               log files live here
├── usr/                   installed programs and libraries
└── tmp/                   temporary files (cleared on reboot)
```

The navigation commands:

```bash
pwd                 # print working directory: where am I?
ls                  # list files in the current directory
ls -la              # list all (including hidden) in long format
cd /var/log         # change directory to an absolute path
cd app              # change into the 'app' subdirectory (relative)
cd ..               # go up one level to the parent
cd ~                # go to your home directory
cd -                # go back to the previous directory
```

Paths come in two kinds:

- **Absolute** paths start from root: `/home/alice/app/src`. They mean the same thing no matter where you are.
- **Relative** paths start from the current directory: `src/index.ts`, `../config`. `.` means "here", `..` means "the parent", `~` means "my home directory".

Hidden files start with a dot (`.env`, `.gitignore`) and do not show in a plain `ls`; use `ls -a` to see them. Backend configuration often lives in hidden files, so this matters.

#### Reading files

```bash
cat app.log           # print the whole file (fine for small files)
less app.log          # page through a large file (q to quit, / to search)
head -n 20 app.log    # first 20 lines
tail -n 20 app.log    # last 20 lines
tail -f app.log       # follow: show new lines as they are written (live logs!)
```

`tail -f` is one you will use constantly — it streams a log file live, so you watch your server's output as it happens. For a huge log, `less` lets you page and search without loading it all; never `cat` a multi-gigabyte log file, because it dumps the whole thing to your screen.

#### Creating, moving, copying, deleting

```bash
mkdir logs            # make a directory
mkdir -p a/b/c        # make nested directories, creating parents as needed
touch notes.txt       # create an empty file (or update its timestamp)
cp a.txt b.txt        # copy
cp -r src backup      # copy a directory and its contents (-r = recursive)
mv old.txt new.txt    # move or rename
rm notes.txt          # delete a file
rm -r backup          # delete a directory and everything in it
```

#### Edge cases & failure modes

- **`rm -rf` is irreversible and has no trash.** `rm -rf /` or `rm -rf $VAR/` where `$VAR` is empty has destroyed whole systems. There is no undo. Double-check every `rm -rf`, especially with variables or wildcards.
- **Spaces in filenames** break commands unless quoted: `rm my file.txt` tries to delete two files; use `rm "my file.txt"`.
- **Wildcards expand before the command runs**: `rm *.log` deletes all `.log` files; `rm * .log` (stray space) deletes everything in the directory. A space changes the meaning entirely.
- **Hidden files** are missed by `ls` and by `cp *` (which skips dotfiles), so a backup can silently omit `.env`.
- **Relative paths depend on where you are**, so a script using relative paths breaks if run from a different directory.

#### How a Senior Backend Engineer thinks about this

A senior treats destructive commands (`rm -rf`, `mv` over an existing file) with deliberate caution, especially when variables or wildcards are involved, because there is no recycle bin on a server. They prefer absolute paths in scripts so behavior does not depend on the current directory. They know where things live by convention — logs in `/var/log`, config in `/etc`, their app in `/home` or `/opt` or `/var/www` — so they can find their way on any Linux box. They use `tail -f` to watch live logs and `less` to search large ones, never `cat` on a huge file.

#### Common mistakes

- `rm -rf` with a wildcard or an empty variable, deleting far more than intended.
- Forgetting to quote filenames with spaces.
- Using relative paths in scripts that then break when run from elsewhere.
- `cat`-ing a huge log file and flooding the terminal.
- Backing up with `cp *` and silently missing hidden files like `.env`.

#### Interview questions

1. **What is the difference between an absolute and a relative path?** Absolute starts from `/` and is location-independent; relative starts from the current directory (`.`, `..`, no leading slash).
2. **How do you watch a log file update live?** `tail -f file`; for searching a large file, `less`.
3. **Why is `rm -rf` dangerous and how do you use it safely?** It deletes recursively with no undo and no trash; double-check the exact path, avoid empty variables and stray spaces in wildcards, and prefer explicit paths.
4. **Why might a backup made with `cp *` be incomplete?** Wildcard expansion skips hidden dotfiles like `.env`; use `cp -r` on the directory or include dotfiles explicitly.

#### Practical exercise

Create a directory `~/practice`, inside it create `src/` and `logs/`, create an empty `.env` file and a `README.md`, list all files including hidden ones, copy `src/` to a `backup/`, then rename `README.md` to `NOTES.md`. Finally, confirm the `.env` file exists with `ls -a`. Acceptance criteria: you use both absolute and relative paths at least once, and you can explain why a plain `ls` did not show `.env`.
