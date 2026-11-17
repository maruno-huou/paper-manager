import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { initializeFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// ★ 自分専用モードに切り替える合言葉（好きな文字列に変更OK）
const SECRET_PASSCODE = import.meta.env.VITE_SECRET_PASSCODE || "demo";

// ★ 面接官・閲覧者向けのデモ用サンプル論文データ
const DEMO_PAPERS = [
  {
    id: "demo-1",
    title: "Minimum Wages and Employment: A Case Study of the Fast-Food Industry (Card & Krueger, 1994)",
    folder: "Labor Economics/Minimum Wage",
    abstract: "Research Question: Does an increase in the minimum wage reduce employment in low-wage industries?\nData Used: Survey data from 410 fast-food restaurants in New Jersey and eastern Pennsylvania before and after NJ's 1992 minimum wage increase.\nMethodology: Difference-in-Differences (DID).\nConclusion: Found no indication that the rise in the minimum wage reduced employment.",
    memo: "【識別戦略メモ】\n・処置群：ニュージャージー州（最低賃金 $4.25 → $5.05）\n・対照群：隣接するペンシルベニア州東部（$4.25のまま）\n・平行トレンド仮定の妥当性と店舗レベルのパネル構築がポイント。"
  },
  {
    id: "demo-2",
    title: "Children and Gender Inequality: Evidence from Denmark (Kleven et al., 2019)",
    folder: "Labor Economics/Gender",
    abstract: "Research Question: How much of the remaining gender inequality in earnings can be explained by the arrival of children?\nData Used: Danish administrative data covering the full population from 1980 to 2013.\nMethodology: Event Study around the birth of the first child.\nConclusion: The arrival of children creates a long-run gender gap in earnings of about 20%, driven by labor force participation, hours worked, and wage rates.",
    memo: "【チャイルド・ペナルティ整理】\n・第一子出産をイベントとしたイベントスタディ。\n・出産前は男女で平行トレンドだが、出産直後に女性のみ所得が急落し回復しない。"
  },
  {
    id: "demo-3",
    title: "The Colonial Origins of Comparative Development (Acemoglu, Johnson, & Robinson, 2001)",
    folder: "Development & Institutions",
    abstract: "Research Question: What is the fundamental cause of large differences in income per capita across countries?\nData Used: Cross-country data on settler mortality, institutional quality (expropriation risk), and GDP per capita.\nMethodology: Instrumental Variables (2SLS) using European settler mortality as an instrument for current institutions.\nConclusion: Differences in institutions account for roughly three-quarters of the income per capita differences across former colonies.",
    memo: "【操作変数（IV）の妥当性】\n・除外制約：過去の入植者死亡率は「当時の制度形成」を通じてのみ現代の所得に影響する。"
  }
];

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};
const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
});

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY);

// ブラウザ内データベース（IndexedDB）にPDFを無料保存するヘルパー
const openPdfDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("PaperManagerPDFs", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("pdfs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const savePdfLocally = async (paperId, file) => {
  const idb = await openPdfDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put(file, paperId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const getPdfLocally = async (paperId) => {
  const idb = await openPdfDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("pdfs", "readonly");
    const req = tx.objectStore("pdfs").get(paperId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

const deletePdfLocally = async (paperId) => {
  const idb = await openPdfDB();
  const tx = idb.transaction("pdfs", "readwrite");
  tx.objectStore("pdfs").delete(paperId);
};

const generateWithFallback = async (prompt, mode = "flash") => {
  const modelsToTry =
    mode === "pro"
      ? ["gemini-3.5-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
      : ["gemini-3.5-flash", "gemini-3.5-flash-lite"];

  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      lastError = error;
      const msg = error.message || "";
      if (msg.includes("503") || msg.includes("429") || msg.includes("404") || msg.includes("high demand")) {
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

function App() {
  const [isPersonalMode, setIsPersonalMode] = useState(() => {
    return localStorage.getItem("paperManagerUnlocked") === "true";
  });

  const [papers, setPapers] = useState([]);
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [chat, setChat] = useState([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");

  // メモ機能用の状態
  const [memoText, setMemoText] = useState("");
  const [memoStatus, setMemoStatus] = useState("");

  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAbstract, setNewAbstract] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [pendingPdfFile, setPendingPdfFile] = useState(null);
  
  const [aiLanguage, setAiLanguage] = useState("Japanese");
  const [currentPdfUrl, setCurrentPdfUrl] = useState(null);
  const [savedPdfIds, setSavedPdfIds] = useState({});

  // 左サイドバーの幅（px）＆リサイズ状態
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  // 真ん中（PDF vs 右パネル）の左右リサイズ用（%）
  const [leftWidth, setLeftWidth] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  // 右ペイン内の上下リサイズ用（AIの高さ %）
  const [aiHeightPercent, setAiHeightPercent] = useState(50);
  const [isDraggingVertical, setIsDraggingVertical] = useState(false);
  const rightPaneRef = useRef(null);
  
  const [activeFolder, setActiveFolder] = useState("");
  const [customFolders, setCustomFolders] = useState([]);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [openMenuId, setOpenMenuId] = useState(null);

  const [draggedItem, setDraggedItem] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);

  const isSidebarOpen = sidebarWidth > 0;

  // 合言葉でモード切り替え
  const handleToggleMode = () => {
    if (isPersonalMode) {
      const ok = window.confirm("デモモード（面接官・閲覧者向け表示）に戻しますか？");
      if (ok) {
        localStorage.removeItem("paperManagerUnlocked");
        setIsPersonalMode(false);
        setSelectedPaper(null);
        setIsAdding(false);
      }
    } else {
      const input = window.prompt("自分専用モードの合言葉を入力してください：");
      if (input === SECRET_PASSCODE) {
        localStorage.setItem("paperManagerUnlocked", "true");
        setIsPersonalMode(true);
        setSelectedPaper(null);
        setIsAdding(false);
      } else if (input !== null) {
        alert("合言葉が違います。");
      }
    }
  };

  const handleMouseMove = (e) => {
    // 1. 左サイドバーの幅リサイズ
    if (isDraggingSidebar) {
      const rawSidebarWidth = e.clientX;
      if (rawSidebarWidth < 80) {
        setSidebarWidth(0); // 左端まで寄せたら収納
      } else {
        const clamped = Math.min(Math.max(rawSidebarWidth, 160), 520);
        setSidebarWidth(clamped);
      }
    }

    // 2. PDF vs 右パネルの左右仕切り移動
    if (isDragging) {
      const leftAreaWidth = isSidebarOpen ? sidebarWidth + 6 : 40;
      const resizerWidth = 6;
      const availableWidth = window.innerWidth - leftAreaWidth - resizerWidth;
      if (availableWidth > 0) {
        const rawWidth = ((e.clientX - leftAreaWidth) / availableWidth) * 100;
        if (rawWidth >= 95) {
          setLeftWidth(100);
        } else if (rawWidth >= 20) {
          setLeftWidth(rawWidth);
        } else {
          setLeftWidth(20);
        }
      }
    }

    // 3. 右パネル内の上下仕切り移動（AI vs メモ）
    if (isDraggingVertical && rightPaneRef.current) {
      const rect = rightPaneRef.current.getBoundingClientRect();
      const resizerHeight = 6;
      const availableHeight = rect.height - resizerHeight;
      if (availableHeight > 0) {
        const rawHeight = ((e.clientY - rect.top) / availableHeight) * 100;
        if (rawHeight <= 5) {
          setAiHeightPercent(0);
        } else if (rawHeight >= 95) {
          setAiHeightPercent(100);
        } else {
          setAiHeightPercent(rawHeight);
        }
      }
    }
  };

  const handleMouseUp = () => {
    if (isDraggingSidebar) setIsDraggingSidebar(false);
    if (isDragging) setIsDragging(false);
    if (isDraggingVertical) setIsDraggingVertical(false);
  };

  const checkSavedPdfs = async (papersList) => {
    const statusMap = {};
    for (const p of papersList) {
      try {
        const file = await getPdfLocally(p.id);
        if (file) statusMap[p.id] = true;
      } catch (e) {}
    }
    setSavedPdfIds(statusMap);
  };

  const fetchPapers = async () => {
    if (!isPersonalMode) {
      setPapers(DEMO_PAPERS);
      setSavedPdfIds({});
      return;
    }
    try {
      const querySnapshot = await getDocs(collection(db, "papers"));
      const papersData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setPapers(papersData);
      await checkSavedPdfs(papersData);
    } catch (error) {
      console.error("Failed to fetch data", error);
    }
  };

  useEffect(() => {
    fetchPapers();
  }, [isPersonalMode]);

  useEffect(() => {
    const closeMenu = () => setOpenMenuId(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  // メモの保存処理
  const handleSaveMemo = async (paperId, textToSave) => {
    if (!paperId) return;
    if (!isPersonalMode) {
      setPapers(prev => prev.map(p => (p.id === paperId ? { ...p, memo: textToSave } : p)));
      setSelectedPaper(prev => (prev && prev.id === paperId ? { ...prev, memo: textToSave } : prev));
      setMemoStatus("Saved (Demo) ✓");
      return;
    }

    setMemoStatus("Saving...");
    try {
      await updateDoc(doc(db, "papers", paperId), { memo: textToSave });
      setPapers(prev => prev.map(p => (p.id === paperId ? { ...p, memo: textToSave } : p)));
      setSelectedPaper(prev => (prev && prev.id === paperId ? { ...prev, memo: textToSave } : prev));
      setMemoStatus("Saved ✓");
    } catch (error) {
      console.error("Failed to save memo:", error);
      setMemoStatus("Save failed");
    }
  };

  // 入力が止まって1.2秒後に自動保存
  useEffect(() => {
    if (!selectedPaper) return;
    const savedMemo = selectedPaper.memo || "";
    if (memoText === savedMemo) return;

    setMemoStatus("Editing...");
    const timer = setTimeout(() => {
      handleSaveMemo(selectedPaper.id, memoText);
    }, 1200);

    return () => clearTimeout(timer);
  }, [memoText, selectedPaper]);

  const getAllFolderPaths = () => {
    const rawSet = new Set([
      ...customFolders,
      ...papers.map(p => p.folder || "Uncategorized")
    ]);
    const fullSet = new Set();
    rawSet.forEach(path => {
      if (!path || path === "All") return;
      const parts = path.split('/');
      let current = "";
      parts.forEach((part, idx) => {
        current = idx === 0 ? part : `${current}/${part}`;
        fullSet.add(current);
      });
    });

    return Array.from(fullSet).sort((a, b) => {
      if (a === "Uncategorized") return 1;
      if (b === "Uncategorized") return -1;
      return a.localeCompare(b);
    });
  };

  const allFolderPaths = getAllFolderPaths();

  const handleDropOnFolder = async (targetPath) => {
    setDragOverTarget(null);
    if (!draggedItem) return;

    if (draggedItem.type === 'paper') {
      const destination = targetPath === "ROOT" ? "Uncategorized" : targetPath;
      if (draggedItem.currentFolder === destination) {
        setDraggedItem(null);
        return;
      }
      if (!isPersonalMode) {
        setPapers(prev => prev.map(p => (p.id === draggedItem.id ? { ...p, folder: destination } : p)));
        setExpandedFolders(prev => ({ ...prev, [destination]: true }));
        setDraggedItem(null);
        return;
      }
      try {
        await updateDoc(doc(db, "papers", draggedItem.id), { folder: destination });
        setExpandedFolders(prev => ({ ...prev, [destination]: true }));
        await fetchPapers();
      } catch (error) {
        alert("移動に失敗しました: " + error.message);
      }
      setDraggedItem(null);
      return;
    }

    if (draggedItem.type === 'folder') {
      const sourcePath = draggedItem.path;
      setDraggedItem(null);

      if (sourcePath === "Uncategorized" || sourcePath === targetPath) return;
      if (targetPath !== "ROOT" && targetPath.startsWith(sourcePath + '/')) return;

      const parts = sourcePath.split('/');
      const leafName = parts[parts.length - 1];
      const newPath = targetPath === "ROOT" ? leafName : `${targetPath}/${leafName}`;

      if (newPath === sourcePath) return;

      if (!isPersonalMode) {
        setPapers(prev => prev.map(p => {
          if (p.folder === sourcePath) return { ...p, folder: newPath };
          if ((p.folder || "").startsWith(sourcePath + '/')) return { ...p, folder: newPath + p.folder.slice(sourcePath.length) };
          return p;
        }));
        setCustomFolders(prev => {
          const next = prev.map(f => {
            if (f === sourcePath) return newPath;
            if (f.startsWith(sourcePath + '/')) return newPath + f.slice(sourcePath.length);
            return f;
          });
          return Array.from(new Set([...next, newPath]));
        });
        if (targetPath !== "ROOT") {
          setExpandedFolders(prev => ({ ...prev, [targetPath]: true }));
        }
        return;
      }

      setLoading(true);
      setLoadingMessage("Moving folder...");
      try {
        const targetPapers = papers.filter(p => p.folder === sourcePath || (p.folder || "").startsWith(sourcePath + '/'));
        for (const p of targetPapers) {
          const updatedFolder = p.folder === sourcePath ? newPath : newPath + p.folder.slice(sourcePath.length);
          await updateDoc(doc(db, "papers", p.id), { folder: updatedFolder });
        }
        setCustomFolders(prev => {
          const next = prev.map(f => {
            if (f === sourcePath) return newPath;
            if (f.startsWith(sourcePath + '/')) return newPath + f.slice(sourcePath.length);
            return f;
          });
          return Array.from(new Set([...next, newPath]));
        });
        if (targetPath !== "ROOT") {
          setExpandedFolders(prev => ({ ...prev, [targetPath]: true }));
        }
        await fetchPapers();
      } catch (error) {
        alert("フォルダの移動に失敗しました: " + error.message);
      }
      setLoading(false);
    }
  };

  const handleCreateRootFolder = () => {
    const name = window.prompt("新しいフォルダ（タブ）の名前を入力してください：\n（例: Labor Economics）");
    if (!name || !name.trim()) return;
    const cleanName = name.trim().replace(/\//g, '-');
    setCustomFolders(prev => Array.from(new Set([...prev, cleanName])));
    setExpandedFolders(prev => ({ ...prev, [cleanName]: true }));
    setActiveFolder(cleanName);
  };

  const handleCreateSubFolder = (parentPath) => {
    const subName = window.prompt(`「${parentPath}」の中に作るサブフォルダ名を入力してください：`);
    if (!subName || !subName.trim()) return;
    const cleanSub = subName.trim().replace(/\//g, '-');
    const fullPath = `${parentPath}/${cleanSub}`;
    setCustomFolders(prev => Array.from(new Set([...prev, fullPath])));
    setExpandedFolders(prev => ({ ...prev, [parentPath]: true, [fullPath]: true }));
    setActiveFolder(fullPath);
  };

  const handleRenameFolder = async (oldPath) => {
    const parts = oldPath.split('/');
    const oldLeafName = parts[parts.length - 1];
    const newLeafName = window.prompt("新しいフォルダ名を入力してください：", oldLeafName);
    if (!newLeafName || !newLeafName.trim() || newLeafName.trim() === oldLeafName) return;

    const cleanLeaf = newLeafName.trim().replace(/\//g, '-');
    parts[parts.length - 1] = cleanLeaf;
    const newPath = parts.join('/');

    if (!isPersonalMode) {
      setPapers(prev => prev.map(p => {
        if (p.folder === oldPath) return { ...p, folder: newPath };
        if ((p.folder || "").startsWith(oldPath + '/')) return { ...p, folder: newPath + p.folder.slice(oldPath.length) };
        return p;
      }));
      setCustomFolders(prev => prev.map(f => {
        if (f === oldPath) return newPath;
        if (f.startsWith(oldPath + '/')) return newPath + f.slice(oldPath.length);
        return f;
      }));
      return;
    }

    setLoading(true);
    setLoadingMessage("Renaming folder...");
    try {
      const targetPapers = papers.filter(p => p.folder === oldPath || (p.folder || "").startsWith(oldPath + '/'));
      for (const p of targetPapers) {
        const updatedFolder = p.folder === oldPath ? newPath : newPath + p.folder.slice(oldPath.length);
        await updateDoc(doc(db, "papers", p.id), { folder: updatedFolder });
      }
      setCustomFolders(prev => prev.map(f => {
        if (f === oldPath) return newPath;
        if (f.startsWith(oldPath + '/')) return newPath + f.slice(oldPath.length);
        return f;
      }));
      await fetchPapers();
    } catch (error) {
      alert("名前の変更に失敗しました: " + error.message);
    }
    setLoading(false);
  };

  const handleDeleteFolder = async (targetPath) => {
    const ok = window.confirm(`フォルダ「${targetPath}」を削除しますか？\n（※中の論文は消えず「Uncategorized」に移動します）`);
    if (!ok) return;

    if (!isPersonalMode) {
      setPapers(prev => prev.map(p => (p.folder === targetPath || (p.folder || "").startsWith(targetPath + '/') ? { ...p, folder: "Uncategorized" } : p)));
      setCustomFolders(prev => prev.filter(f => f !== targetPath && !f.startsWith(targetPath + '/')));
      return;
    }

    setLoading(true);
    setLoadingMessage("Deleting folder...");
    try {
      const targetPapers = papers.filter(p => p.folder === targetPath || (p.folder || "").startsWith(targetPath + '/'));
      for (const p of targetPapers) {
        await updateDoc(doc(db, "papers", p.id), { folder: "Uncategorized" });
      }
      setCustomFolders(prev => prev.filter(f => f !== targetPath && !f.startsWith(targetPath + '/')));
      await fetchPapers();
    } catch (error) {
      alert("削除に失敗しました: " + error.message);
    }
    setLoading(false);
  };

  const handleRenamePaper = async (paper) => {
    const newTitleInput = window.prompt("新しい論文タイトルを入力してください：", paper.title);
    if (!newTitleInput || !newTitleInput.trim() || newTitleInput.trim() === paper.title) return;
    if (!isPersonalMode) {
      setPapers(prev => prev.map(p => (p.id === paper.id ? { ...p, title: newTitleInput.trim() } : p)));
      if (selectedPaper?.id === paper.id) {
        setSelectedPaper({ ...selectedPaper, title: newTitleInput.trim() });
      }
      return;
    }
    try {
      await updateDoc(doc(db, "papers", paper.id), { title: newTitleInput.trim() });
      if (selectedPaper?.id === paper.id) {
        setSelectedPaper({ ...selectedPaper, title: newTitleInput.trim() });
      }
      await fetchPapers();
    } catch (error) {
      alert("タイトルの変更に失敗しました: " + error.message);
    }
  };

  const handleMovePaper = async (paper) => {
    const dest = window.prompt(
      "移動先のフォルダ名を入力してください：\n（サブフォルダにする場合は「親フォルダ/サブフォルダ」のように / で区切ります）",
      paper.folder || "Uncategorized"
    );
    if (!dest || !dest.trim()) return;
    if (!isPersonalMode) {
      setPapers(prev => prev.map(p => (p.id === paper.id ? { ...p, folder: dest.trim() } : p)));
      setExpandedFolders(prev => ({ ...prev, [dest.trim()]: true }));
      return;
    }
    try {
      await updateDoc(doc(db, "papers", paper.id), { folder: dest.trim() });
      setExpandedFolders(prev => ({ ...prev, [dest.trim()]: true }));
      await fetchPapers();
    } catch (error) {
      alert("移動に失敗しました: " + error.message);
    }
  };

  const handleDeletePaper = async (paper) => {
    const ok = window.confirm(`論文「${paper.title}」を完全に削除しますか？`);
    if (!ok) return;
    if (!isPersonalMode) {
      setPapers(prev => prev.filter(p => p.id !== paper.id));
      if (selectedPaper?.id === paper.id) setSelectedPaper(null);
      return;
    }
    try {
      await deleteDoc(doc(db, "papers", paper.id));
      await deletePdfLocally(paper.id);
      if (selectedPaper?.id === paper.id) {
        setSelectedPaper(null);
      }
      await fetchPapers();
    } catch (error) {
      alert("削除に失敗しました: " + error.message);
    }
  };

  const handleSelectPaper = async (paper) => {
    setIsAdding(false);
    setSelectedPaper(paper);
    setActiveFolder(paper.folder || "");
    setChat([]);
    setCurrentPdfUrl(null);
    setMemoText(paper.memo || "");
    setMemoStatus("");

    if (isPersonalMode) {
      try {
        const savedFile = await getPdfLocally(paper.id);
        if (savedFile) {
          setCurrentPdfUrl(URL.createObjectURL(savedFile));
        }
      } catch (e) {
        console.error("Failed to load saved PDF", e);
      }
    }

    if (!paper.abstract || !paper.abstract.trim()) {
      setChat([{ role: 'ai', text: "（要約用テキストが未登録です。下のメモ欄に自由にノートを記入できます）" }]);
      return;
    }

    setLoading(true);
    setLoadingMessage("Gemini is summarizing the paper...");
    try {
      const prompt = `Please summarize the following paper in about 3 sentences. Write the summary entirely in ${aiLanguage}.\nTitle: ${paper.title}\nContent: ${paper.abstract}`;
      const responseText = await generateWithFallback(prompt);
      setChat([{ role: 'ai', text: responseText }]);
    } catch (error) {
      setChat([{ role: 'ai', text: "Failed to call Gemini API." }]);
    }
    setLoading(false);
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || !selectedPaper) return;
    const newChat = [...chat, { role: 'user', text: inputText }];
    setChat(newChat);
    setInputText("");
    setLoading(true);
    setLoadingMessage("Gemini is generating an answer...");

    try {
      const contextText = selectedPaper.abstract || memoText || "No abstract provided.";
      const prompt = `This is a question regarding the paper "${selectedPaper.title}". Please answer based on the following content. Write your answer entirely in ${aiLanguage}.\nContent: ${contextText}\n\nQuestion: ${inputText}`;
      const responseText = await generateWithFallback(prompt, "pro");
      setChat([...newChat, { role: 'ai', text: responseText }]);
    } catch (error) {
      setChat([...newChat, { role: 'ai', text: "An error occurred." }]);
    }
    setLoading(false);
  };

  const handlePdfUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setLoadingMessage("Extracting text from PDF...");
    setPendingPdfFile(file);
    setCurrentPdfUrl(URL.createObjectURL(file));

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const maxPages = Math.min(pdf.numPages, 5);
      
      let extractedText = "";
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(" ");
        extractedText += `\n--- Page ${i} ---\n${pageText}`;
      }

      setLoadingMessage("Gemini is summarizing...");

      const prompt = `Read the following extracted text from an academic paper and extract the exact "Title" and a structured "Abstract". 
      Adapt the structure based on the paper's field and methodology. 
      Output everything entirely in ${aiLanguage}.
      CRITICAL INSTRUCTION: Be highly concise. Write a maximum of 1 to 2 short sentences per bullet point. Do not generate long paragraphs.

      Format:
      Title: [Title here]
      Abstract:
      (If the paper is Empirical Analysis / Econometrics)
      - Research Question:
      - Data Used:
      - Main Variables (Dependent & Explanatory):
      - Methodology (e.g., FEs, IV):
      - Key Identification Assumption:
      - Conclusion:
      - General Summary:

      (If the paper is Historical, Qualitative, or Theoretical)
      - Core Theme / Research Question:
      - Background / Context:
      - Analytical Framework / Approach:
      - Main Arguments / Findings:
      - Conclusion:
      - General Summary:

      Paper Text:
      ${extractedText}`;

      const text = await generateWithFallback(prompt);

      setNewTitle(file.name.replace('.pdf', ''));
      setNewAbstract(`[Extracted by Gemini]\n\n${text}`);
    } catch (error) {
      console.error(error);
      alert("Failed to read PDF: " + error.message);
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const handleViewerPdfLoad = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setCurrentPdfUrl(URL.createObjectURL(file));
    if (selectedPaper && isPersonalMode) {
      try {
        await savePdfLocally(selectedPaper.id, file);
        setSavedPdfIds(prev => ({ ...prev, [selectedPaper.id]: true }));
      } catch (error) {
        console.error("Failed to save PDF locally:", error);
      }
    }
  };

  const handleAddPaper = async () => {
    if (!newTitle.trim()) return;
    const folderName = newFolder.trim() || "Uncategorized";

    if (!isPersonalMode) {
      const demoNew = {
        id: `demo-${Date.now()}`,
        title: newTitle,
        abstract: newAbstract,
        memo: "",
        folder: folderName
      };
      setPapers(prev => [...prev, demoNew]);
      setNewTitle("");
      setNewAbstract("");
      setNewFolder("");
      setPendingPdfFile(null);
      setIsAdding(false);
      setExpandedFolders(prev => ({ ...prev, [folderName]: true }));
      return;
    }

    setLoading(true);
    setLoadingMessage("Saving to database...");
    
    try {
      const docRef = await addDoc(collection(db, "papers"), {
        title: newTitle,
        abstract: newAbstract,
        memo: "",
        folder: folderName,
        createdAt: new Date()
      });

      if (pendingPdfFile) {
        await savePdfLocally(docRef.id, pendingPdfFile);
      }

      setNewTitle("");
      setNewAbstract("");
      setNewFolder("");
      setPendingPdfFile(null);
      setIsAdding(false);
      setExpandedFolders(prev => ({ ...prev, [folderName]: true }));
      await fetchPapers();
    } catch (error) {
      alert("Failed to save: " + error.message);
    }
    setLoading(false);
  };

  const renderTreeNodes = (parentPath = "", depth = 0) => {
    const childFolders = allFolderPaths.filter(path => {
      if (parentPath === "") {
        return !path.includes('/');
      } else {
        if (!path.startsWith(parentPath + '/')) return false;
        const remainder = path.slice(parentPath.length + 1);
        return !remainder.includes('/');
      }
    });

    const directPapers = parentPath === ""
      ? []
      : papers.filter(p => (p.folder || "Uncategorized") === parentPath);

    return (
      <>
        {directPapers.map(paper => {
          const paperMenuKey = `paper-${paper.id}`;
          const isPaperSelected = selectedPaper?.id === paper.id;

          return (
            <div
              key={paper.id}
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                setDraggedItem({ type: 'paper', id: paper.id, currentFolder: paper.folder || "Uncategorized" });
              }}
              onDragEnd={() => {
                setDraggedItem(null);
                setDragOverTarget(null);
              }}
              onClick={() => handleSelectPaper(paper)}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 6px',
                paddingLeft: `${12 + depth * 16}px`,
                borderRadius: '6px',
                cursor: 'grab',
                fontSize: '13px',
                backgroundColor: isPaperSelected ? '#e8f0fe' : 'transparent',
                color: isPaperSelected ? '#1a73e8' : '#333',
                fontWeight: isPaperSelected ? 'bold' : 'normal',
                marginBottom: '2px',
                opacity: draggedItem?.type === 'paper' && draggedItem?.id === paper.id ? 0.4 : 1
              }}
              title="Drag to move to another folder"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', flex: 1 }}>
                <span style={{ fontSize: '12px', flexShrink: 0 }}>{savedPdfIds[paper.id] ? '📄' : '📝'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {paper.title}
                </span>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === paperMenuKey ? null : paperMenuKey);
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: '14px', color: '#666', flexShrink: 0 }}
                title="Paper options"
              >
                ⋮
              </button>

              {openMenuId === paperMenuKey && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute', right: '8px', top: '26px', zIndex: 100,
                    backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '6px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)', width: '150px', overflow: 'hidden', fontWeight: 'normal'
                  }}
                >
                  <div
                    onClick={() => { setOpenMenuId(null); handleRenamePaper(paper); }}
                    style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', borderBottom: '1px solid #eee', color: '#333' }}
                  >
                    ✏️ Rename Paper
                  </div>
                  <div
                    onClick={() => { setOpenMenuId(null); handleMovePaper(paper); }}
                    style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', borderBottom: '1px solid #eee', color: '#333' }}
                  >
                    📁 Move to Folder...
                  </div>
                  <div
                    onClick={() => { setOpenMenuId(null); handleDeletePaper(paper); }}
                    style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', color: '#d9534f' }}
                  >
                    🗑️ Delete Paper
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {childFolders.map(folderPath => {
          const parts = folderPath.split('/');
          const name = parts[parts.length - 1];
          const isExpanded = expandedFolders[folderPath] !== false;
          const isDragOver = dragOverTarget === folderPath;
          const menuKey = `folder-${folderPath}`;
          const totalCount = papers.filter(p => (p.folder || "Uncategorized") === folderPath || (p.folder || "").startsWith(folderPath + '/')).length;

          return (
            <div key={folderPath}>
              <div
                style={{ position: 'relative' }}
                draggable={folderPath !== "Uncategorized"}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDraggedItem({ type: 'folder', path: folderPath });
                }}
                onDragEnd={() => {
                  setDraggedItem(null);
                  setDragOverTarget(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverTarget(folderPath);
                }}
                onDragLeave={() => {
                  if (dragOverTarget === folderPath) setDragOverTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDropOnFolder(folderPath);
                }}
              >
                <div
                  onClick={() => {
                    setActiveFolder(folderPath);
                    setExpandedFolders(prev => ({ ...prev, [folderPath]: !isExpanded }));
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 6px',
                    paddingLeft: `${6 + depth * 16}px`,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold',
                    backgroundColor: isDragOver ? '#d2e3fc' : 'transparent',
                    border: isDragOver ? '2px dashed #1a73e8' : '2px solid transparent',
                    color: '#222',
                    marginBottom: '2px',
                    opacity: draggedItem?.type === 'folder' && draggedItem?.path === folderPath ? 0.4 : 1
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden', flex: 1 }}>
                    <span style={{ fontSize: '10px', width: '14px', textAlign: 'center', color: '#555', flexShrink: 0 }}>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📁 {name}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <span style={{ fontSize: '11px', color: '#888', fontWeight: 'normal' }}>{totalCount}</span>
                    {folderPath !== "Uncategorized" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(openMenuId === menuKey ? null : menuKey);
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: '14px', color: '#555', borderRadius: '4px' }}
                        title="Folder options"
                      >
                        ⋮
                      </button>
                    )}
                  </div>
                </div>

                {openMenuId === menuKey && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute', right: '8px', top: '28px', zIndex: 100,
                      backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '6px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)', width: '155px', overflow: 'hidden', fontWeight: 'normal'
                    }}
                  >
                    <div
                      onClick={() => { setOpenMenuId(null); handleCreateSubFolder(folderPath); }}
                      style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                    >
                      ＋ Add Sub-folder
                    </div>
                    <div
                      onClick={() => { setOpenMenuId(null); handleRenameFolder(folderPath); }}
                      style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                    >
                      ✏️ Rename
                    </div>
                    <div
                      onClick={() => { setOpenMenuId(null); handleDeleteFolder(folderPath); }}
                      style={{ padding: '8px 12px', fontSize: '12px', cursor: 'pointer', color: '#d9534f' }}
                    >
                      🗑️ Delete
                    </div>
                  </div>
                )}
              </div>

              {isExpanded && renderTreeNodes(folderPath, depth + 1)}
            </div>
          );
        })}
      </>
    );
  };

  const isRightCollapsed = leftWidth >= 100;
  const isAnyDragging = isDraggingSidebar || isDragging || isDraggingVertical;

  return (
    <div 
      onMouseMove={handleMouseMove} 
      onMouseUp={handleMouseUp} 
      onMouseLeave={handleMouseUp}
      style={{
        display: 'flex',
        height: '100vh',
        fontFamily: 'sans-serif',
        color: '#333',
        backgroundColor: '#fff',
        userSelect: isAnyDragging ? 'none' : 'auto',
        cursor: isDraggingSidebar || isDragging ? 'col-resize' : isDraggingVertical ? 'row-resize' : 'auto'
      }}
    >
      {/* サイドバーが完全に閉じているときの細長いバー */}
      {!isSidebarOpen && (
        <div style={{ width: '40px', backgroundColor: '#f8f9fa', borderRight: '1px solid #ccc', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '15px', flexShrink: 0 }}>
          <button 
            onClick={() => setSidebarWidth(280)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '10px', color: '#001f3f' }}
            title="Show Sidebar"
          >
            ▶
          </button>
        </div>
      )}

      {/* 左サイドバー本体（スライドバーで幅調整可能） */}
      <div style={{ 
        width: `${sidebarWidth}px`, 
        padding: isSidebarOpen ? '15px' : '0px', 
        backgroundColor: '#f8f9fa', 
        display: 'flex', 
        flexDirection: 'column', 
        flexShrink: 0,
        overflow: 'hidden',
        boxSizing: 'border-box'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', flex: 1 }}>
            <h2
              onDoubleClick={handleToggleMode}
              style={{ fontSize: '17px', margin: 0, color: '#333', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title="Double-click to switch Personal / Demo mode"
            >
              📚 Paper Manager
            </h2>
            {isPersonalMode ? (
              <span
                onClick={handleToggleMode}
                style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '10px', backgroundColor: '#e6f4ea', color: '#137333', fontWeight: 'bold', cursor: 'pointer', flexShrink: 0 }}
                title="Click to lock back to Demo Mode"
              >
                🔓 Personal
              </span>
            ) : (
              <span
                style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '10px', backgroundColor: '#e8f0fe', color: '#1a73e8', fontWeight: 'bold', flexShrink: 0 }}
              >
                Demo
              </span>
            )}
          </div>
          <button 
            onClick={() => setSidebarWidth(0)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', padding: '4px', color: '#001f3f', flexShrink: 0 }}
            title="Hide Sidebar"
          >
            ◀
          </button>
        </div>
        
        <div style={{ marginBottom: '12px' }}>
          <div style={{ marginBottom: '10px' }}>
            <select
              value={aiLanguage}
              onChange={(e) => setAiLanguage(e.target.value)}
              style={{ width: '100%', padding: '7px', borderRadius: '4px', border: '1px solid #ccc', color: '#333', backgroundColor: '#fff', fontSize: '13px' }}
            >
              <option value="Japanese">AI Language: Japanese</option>
              <option value="English">AI Language: English</option>
              <option value="Chinese">AI Language: Chinese</option>
            </select>
          </div>

          <button
            onClick={() => {
              setIsAdding(true);
              setSelectedPaper(null);
              setNewTitle("");
              setNewAbstract("");
              setPendingPdfFile(null);
              setNewFolder(activeFolder && activeFolder !== "Uncategorized" ? activeFolder : "");
              setLoading(false);
              setLoadingMessage("");
              setCurrentPdfUrl(null);
            }}
            style={{ width: '100%', padding: '9px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            ＋ Add New Paper
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #ddd', paddingTop: '8px' }}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverTarget("ROOT");
            }}
            onDragLeave={() => setDragOverTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              handleDropOnFolder("ROOT");
            }}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 6px', marginBottom: '6px', borderRadius: '4px',
              backgroundColor: dragOverTarget === "ROOT" ? '#d2e3fc' : 'transparent',
              border: dragOverTarget === "ROOT" ? '1px dashed #1a73e8' : '1px solid transparent',
              gap: '4px'
            }}
          >
            <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#666', letterSpacing: '0.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              FOLDERS ({papers.length})
            </span>
            <button
              onClick={handleCreateRootFolder}
              style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', padding: '2px 4px', flexShrink: 0 }}
              title="Add new folder"
            >
              ＋ Folder
            </button>
          </div>

          {allFolderPaths.length === 0 && !loading && (
            <p style={{ fontSize: '13px', color: '#666', textAlign: 'center', marginTop: '20px' }}>No papers yet</p>
          )}

          {renderTreeNodes("", 0)}
        </div>
      </div>

      {/* 左サイドバー用のスライドバー（開いているとき表示／ダブルクリックで収納） */}
      {isSidebarOpen && (
        <div
          onMouseDown={() => setIsDraggingSidebar(true)}
          onDoubleClick={() => setSidebarWidth(0)}
          style={{
            width: '6px',
            flexShrink: 0,
            cursor: 'col-resize',
            backgroundColor: isDraggingSidebar ? '#007bff' : '#ddd',
            transition: 'background-color 0.2s',
            zIndex: 10
          }}
          title="Drag to resize sidebar (Double-click to collapse)"
        />
      )}

      {/* メインエリア */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#fff', overflow: 'hidden', minWidth: 0 }}>
        {isAdding ? (
          <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', width: '100%', overflowY: 'auto' }}>
            <h2 style={{ color: '#333' }}>Register New Paper</h2>
            
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#333' }}>
                Folder / Sub-folder Path (use "/" for nested folders, e.g., Economics/Labor)
              </label>
              <input
                type="text"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder="e.g., Labor Economics or Labor Economics/Gender"
                style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px', color: '#333', backgroundColor: '#fff' }}
              />
            </div>

            <div style={{ margin: '20px 0', padding: '20px', backgroundColor: '#f0f7ff', borderRadius: '8px', border: '1px dashed #007bff' }}>
              <h3 style={{ marginTop: 0, fontSize: '16px', color: '#007bff' }}>📄 Auto-extract & Link PDF</h3>
              <p style={{ fontSize: '14px', color: '#555' }}>Select a PDF file. It will be linked to this paper so it opens automatically next time.</p>
              <input type="file" accept="application/pdf" onChange={handlePdfUpload} disabled={loading} style={{ color: '#333' }} />
              {pendingPdfFile && <p style={{ color: '#28a745', fontSize: '13px', fontWeight: 'bold', marginTop: '8px' }}>✅ PDF linked: {pendingPdfFile.name}</p>}
              {loading && <p style={{ color: '#d9534f', fontWeight: 'bold', marginTop: '10px' }}>⏳ {loadingMessage}</p>}
            </div>

            <div style={{ marginTop: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#333' }}>Title</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                style={{ width: '100%', padding: '10px', marginBottom: '20px', border: '1px solid #ccc', borderRadius: '4px', color: '#333', backgroundColor: '#fff' }}
              />
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#333' }}>Extracted Abstract</label>
              <textarea
                value={newAbstract}
                onChange={(e) => setNewAbstract(e.target.value)}
                style={{ width: '100%', height: '200px', padding: '10px', marginBottom: '20px', border: '1px solid #ccc', borderRadius: '4px', color: '#333', backgroundColor: '#fff' }}
              />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={handleAddPaper} disabled={loading} style={{ padding: '10px 20px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  {isPersonalMode ? "Save to Database" : "Add (Demo Mode)"}
                </button>
                <button onClick={() => { setIsAdding(false); setLoading(false); setLoadingMessage(""); }} style={{ padding: '10px 20px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
              </div>
            </div>
          </div>
        ) : selectedPaper ? (
          
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
            {/* 左側：PDF Viewer */}
            <div style={{ width: isRightCollapsed ? 'calc(100% - 6px)' : `${leftWidth}%`, display: 'flex', flexDirection: 'column', backgroundColor: '#fdfdfd', flexShrink: 0 }}>
              {currentPdfUrl ? (
                <div style={{ flex: 1, pointerEvents: isAnyDragging ? 'none' : 'auto' }}>
                  <iframe src={currentPdfUrl} style={{ width: '100%', height: '100%', border: 'none' }} title="PDF Viewer" />
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', textAlign: 'center' }}>
                  <div style={{ padding: '30px', border: '2px dashed #ccc', borderRadius: '8px', backgroundColor: '#fff', maxWidth: '480px' }}>
                    <h3 style={{ margin: '0 0 10px 0', color: '#555' }}>📄 PDF Viewer</h3>
                    <p style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>Select a local PDF file to view it side-by-side with AI & Notes.</p>
                    <input type="file" accept="application/pdf" onChange={handleViewerPdfLoad} style={{ color: '#333' }} />
                    {!isPersonalMode && selectedPaper.abstract && (
                      <div style={{ marginTop: '20px', padding: '12px', backgroundColor: '#f8f9fa', borderRadius: '6px', textAlign: 'left', fontSize: '12px', color: '#444', whiteSpace: 'pre-wrap' }}>
                        <strong>[Sample Paper Abstract]</strong><br />
                        {selectedPaper.abstract}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 中央スライドバー（左右リサイズ／ダブルクリックで右パネル開閉） */}
            <div
              onMouseDown={() => setIsDragging(true)}
              onDoubleClick={() => setLeftWidth(prev => (prev >= 100 ? 50 : 100))}
              style={{
                width: '6px',
                flexShrink: 0,
                cursor: 'col-resize',
                backgroundColor: isDragging ? '#007bff' : '#ddd',
                transition: 'background-color 0.2s',
                zIndex: 10
              }}
              title="Drag to resize horizontally (Double-click to toggle right panel)"
            />

            {/* 右側：上半分 AIチャット ／ 下半分 論文メモ帳（上下スライドバー付き） */}
            <div
              ref={rightPaneRef}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: '#fff',
                minWidth: 0,
                overflow: 'hidden'
              }}
            >
              {/* 右上：AIセクション */}
              <div style={{
                height: aiHeightPercent >= 100 ? 'calc(100% - 6px)' : `${aiHeightPercent}%`,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                padding: isRightCollapsed || aiHeightPercent <= 0 ? '0px' : '15px 20px',
                minHeight: 0,
                overflow: 'hidden'
              }}>
                <h3 style={{ borderBottom: '1px solid #eee', paddingBottom: '8px', margin: '0 0 8px 0', fontSize: '15px', color: '#333', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  🤖 AI Assistant — {selectedPaper.title}
                </h3>
                <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
                  {chat.map((msg, i) => (
                    <div key={i} style={{ marginBottom: '12px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                      <span style={{
                        display: 'inline-block', padding: '10px 14px', borderRadius: '10px',
                        backgroundColor: msg.role === 'user' ? '#007bff' : '#f1f3f4',
                        color: msg.role === 'user' ? 'white' : 'black',
                        maxWidth: '90%', fontSize: '13px', lineHeight: '1.5', whiteSpace: 'pre-wrap'
                      }}>
                        {msg.text}
                      </span>
                    </div>
                  ))}
                  {loading && <div style={{ color: '#666', fontSize: '13px', marginTop: '6px' }}>⏳ {loadingMessage}</div>}
                </div>
                <div style={{ display: 'flex', marginTop: '10px' }}>
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder={`Ask Gemini (${aiLanguage})...`}
                    style={{ flex: 1, padding: '9px 12px', fontSize: '14px', borderRadius: '4px 0 0 4px', border: '1px solid #ccc', color: '#333', backgroundColor: '#fff', minWidth: 0 }}
                  />
                  <button onClick={handleSendMessage} disabled={loading} style={{ padding: '9px 16px', fontSize: '14px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '0 4px 4px 0', cursor: 'pointer', flexShrink: 0 }}>
                    Send
                  </button>
                </div>
              </div>

              {/* 上下スライドバー（AIとメモの境界線／ダブルクリックでAI折りたたみ切替） */}
              <div
                onMouseDown={() => setIsDraggingVertical(true)}
                onDoubleClick={() => setAiHeightPercent(prev => (prev <= 0 ? 50 : 0))}
                style={{
                  height: '6px',
                  flexShrink: 0,
                  cursor: 'row-resize',
                  backgroundColor: isDraggingVertical ? '#007bff' : '#ddd',
                  transition: 'background-color 0.2s',
                  zIndex: 10
                }}
                title="Drag to resize AI & Memo (Double-click to toggle AI)"
              />

              {/* 右下：論文専用メモ帳 */}
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                padding: isRightCollapsed || aiHeightPercent >= 100 ? '0px' : '15px 20px',
                backgroundColor: '#fafafa',
                minHeight: 0,
                overflow: 'hidden'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexShrink: 0 }}>
                  <span style={{ fontWeight: 'bold', fontSize: '14px', color: '#333', whiteSpace: 'nowrap' }}>
                    📝 Paper Memo / Notes
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                    <span style={{ fontSize: '12px', color: memoStatus.includes('Saved') ? '#28a745' : '#888', whiteSpace: 'nowrap' }}>
                      {memoStatus}
                    </span>
                    <button
                      onClick={() => handleSaveMemo(selectedPaper.id, memoText)}
                      style={{
                        padding: '4px 10px',
                        fontSize: '12px',
                        backgroundColor: '#28a745',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
                <textarea
                  value={memoText}
                  onChange={(e) => setMemoText(e.target.value)}
                  placeholder={
                    isPersonalMode
                      ? "Write your notes, identification strategy, or questions here (auto-saved to cloud)..."
                      : "Write your notes, identification strategy, or questions here (Demo mode: saved locally in session)..."
                  }
                  style={{
                    flex: 1,
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '12px',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    border: '1px solid #ccc',
                    borderRadius: '6px',
                    backgroundColor: '#fff',
                    color: '#333',
                    resize: 'none',
                    fontFamily: 'inherit'
                  }}
                />
              </div>
            </div>
          </div>

        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', gap: '8px' }}>
            <h3>👈 Please select a paper from the left menu</h3>
            {!isPersonalMode && (
              <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>
                Currently in Demo Mode — Select a sample paper to test AI summary, PDF viewer, and Notes.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;