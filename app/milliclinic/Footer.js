import styles from "./milliclinic.module.css";

export default function MilliFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`${styles.container} ${styles.footerInner}`}>
        <div>
          <p className={styles.footerBrand}>MILI CLINIC 밀리클리닉</p>
          <p className={styles.footerAddr}>서울특별시 강남구 도산대로45길 17, 3층(신사동) · 대표전화 02-6367-1212</p>
        </div>
        <p className={styles.footerCopy}>&copy; 2026 MILI CLINIC. All rights reserved.</p>
      </div>
    </footer>
  );
}
